#!/usr/bin/env node
// migrate-instance/migrate.js — Outil de migration data inter-instances Opale.
//
// Usage :
//   SOURCE_DSN=postgres://user:pass@host:5432/source_db \
//   TARGET_DSN=postgres://user:pass@host:5432/target_db \
//     node scripts/migrate-instance/migrate.js [options]
//
// Options :
//   --dry-run         Plan + count rows par table sur la source, aucune écriture sur target
//   --verify          Compare row counts source vs target (post-migration check)
//   --tables T1,T2    Limite à un sous-ensemble (debug ou reprise partielle)
//   --batch-size N    Taille de batch INSERT (défaut : 500)
//   --no-reset-seq    Ne pas réinitialiser les séquences PG après migration
//
// Output : JSON Lines sur stdout (pipe vers `tee migration-$(date +%s).jsonl`).

import pg from 'pg';
import { TABLES, TABLE_NAMES, getTableConfig } from './tables.js';

// ─── Logging JSONL ─────────────────────────────────────────────────────────
function log(level, msg, meta = {}) {
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  }) + '\n');
}
const info  = (msg, meta) => log('info',  msg, meta);
const warn  = (msg, meta) => log('warn',  msg, meta);
const error = (msg, meta) => log('error', msg, meta);

// ─── Args parsing ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    dryRun: false,
    verify: false,
    tables: null,
    batchSize: 500,
    resetSeq: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run')      opts.dryRun = true;
    else if (a === '--verify')  opts.verify = true;
    else if (a === '--no-reset-seq') opts.resetSeq = false;
    else if (a === '--tables')  opts.tables = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--batch-size') opts.batchSize = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.error([
        'Usage: SOURCE_DSN=… TARGET_DSN=… node migrate.js [options]',
        '',
        '  --dry-run         Count source rows, no writes to target',
        '  --verify          Compare row counts source vs target',
        '  --tables T1,T2    Restrict to a subset',
        '  --batch-size N    INSERT batch size (default: 500)',
        '  --no-reset-seq    Skip sequence reset',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

// ─── Pool factory + retry ──────────────────────────────────────────────────
function makePool(dsn, label) {
  const pool = new pg.Pool({
    connectionString: dsn,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => warn(`${label}-pool error`, { code: err.code, message: err.message }));
  return pool;
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
]);

async function withRetry(fn, label, maxAttempts = 5) {
  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = err.code || err.cause?.code;
      if (!TRANSIENT_CODES.has(code) || attempt === maxAttempts - 1) throw err;
      const delay = Math.min(60_000, 1000 * Math.pow(2, attempt));
      warn(`${label} transient error, retrying`, { attempt: attempt + 1, code, delayMs: delay });
      await new Promise(r => setTimeout(r, delay));
      attempt++;
    }
  }
  throw lastErr;
}

// ─── Schema introspection ──────────────────────────────────────────────────
async function getColumns(pool, table) {
  const res = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  return res.rows.map(r => r.column_name);
}

async function getPrimaryKey(pool, table) {
  // Récupère les colonnes de la PK dans l'ordre de la définition.
  const res = await pool.query(
    `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
    [`public.${table}`],
  );
  return res.rows.map(r => r.column_name);
}

async function tableExists(pool, table) {
  const res = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return res.rows.length > 0;
}

async function countRows(pool, table) {
  const res = await pool.query(`SELECT count(*)::bigint AS n FROM "${table}"`);
  return Number(res.rows[0].n);
}

// ─── Batch INSERT helper ───────────────────────────────────────────────────
function quoteIdent(ident) {
  // Identifiers sans caractères spéciaux dans notre schéma — protection minimale.
  if (!/^[a-z_][a-z0-9_]*$/i.test(ident)) {
    throw new Error(`Refusing to quote suspicious identifier: ${ident}`);
  }
  return `"${ident}"`;
}

function buildInsertSql(table, columns, rowCount, conflictTarget, mode) {
  const colList = columns.map(quoteIdent).join(', ');
  const placeholders = [];
  for (let r = 0; r < rowCount; r++) {
    const ph = columns.map((_, c) => `$${r * columns.length + c + 1}`).join(', ');
    placeholders.push(`(${ph})`);
  }
  let conflictClause = '';
  if (conflictTarget && conflictTarget.length > 0) {
    const target = conflictTarget.map(quoteIdent).join(', ');
    if (mode === 'update') {
      const updatable = columns.filter(c => !conflictTarget.includes(c));
      if (updatable.length === 0) {
        conflictClause = `ON CONFLICT (${target}) DO NOTHING`;
      } else {
        const setClause = updatable.map(c => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`).join(', ');
        conflictClause = `ON CONFLICT (${target}) DO UPDATE SET ${setClause}`;
      }
    } else {
      conflictClause = `ON CONFLICT (${target}) DO NOTHING`;
    }
  }
  return `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES ${placeholders.join(', ')} ${conflictClause}`;
}

// ─── Pagination par PK (cursor-based) ──────────────────────────────────────
function buildSelectSql(table, columns, pk, hasCursor, limit) {
  const colList = columns.map(quoteIdent).join(', ');
  const orderBy = pk.map(quoteIdent).join(', ');
  let where = '';
  let limitParam = 1;
  if (hasCursor) {
    // Comparaison row-wise pour PK composite : (a, b) > ($1, $2)
    const lhs = pk.map(quoteIdent).join(', ');
    const rhs = pk.map((_, i) => `$${i + 1}`).join(', ');
    where = `WHERE (${lhs}) > (${rhs})`;
    limitParam = pk.length + 1;
  }
  return {
    sql: `SELECT ${colList} FROM ${quoteIdent(table)} ${where} ORDER BY ${orderBy} ASC LIMIT $${limitParam}`,
    limitParam,
  };
}

// ─── Migration d'une table ─────────────────────────────────────────────────
async function copyTable(srcPool, dstPool, cfg, opts) {
  const { name, conflictTarget, mode = 'skip', selfRefColumn } = cfg;

  // Vérifs préalables
  if (!await tableExists(srcPool, name)) {
    warn(`table missing on source, skipping`, { table: name });
    return { copied: 0, total: 0, skipped: true };
  }
  if (!await tableExists(dstPool, name)) {
    error(`table missing on target — schema not migrated?`, { table: name });
    throw new Error(`Target missing table: ${name}`);
  }

  const srcCols = await getColumns(srcPool, name);
  const dstCols = await getColumns(dstPool, name);
  // Intersection : ne migre que les colonnes présentes des deux côtés.
  // Permet de gérer une dérive de schéma mineure entre source et target.
  const columns = srcCols.filter(c => dstCols.includes(c));
  const skippedSrcCols = srcCols.filter(c => !dstCols.includes(c));
  const skippedDstCols = dstCols.filter(c => !srcCols.includes(c));
  if (skippedSrcCols.length > 0) {
    warn(`columns present on source but not target, skipping`, { table: name, columns: skippedSrcCols });
  }
  if (skippedDstCols.length > 0) {
    warn(`columns present on target but not source, leaving target default`, { table: name, columns: skippedDstCols });
  }

  const pk = await getPrimaryKey(dstPool, name);
  if (pk.length === 0) {
    throw new Error(`No primary key found on table ${name} — cannot paginate`);
  }

  // Pour l'auto-référence (agent_tokens.replaced_by) : 1ʳᵉ passe avec NULL forcé.
  const insertColumns = selfRefColumn
    ? columns.filter(c => c !== selfRefColumn)
    : columns;

  // batchSize : on respecte la limite Postgres de 65535 paramètres par query.
  const maxByParams = Math.floor(65000 / Math.max(1, insertColumns.length));
  const batchSize = Math.max(1, Math.min(opts.batchSize, maxByParams));

  let cursor = null;
  let total = 0;
  let inserted = 0;

  // Une transaction par table : rollback si erreur partielle.
  const dst = await dstPool.connect();
  try {
    await dst.query('BEGIN');

    while (true) {
      const { sql, limitParam } = buildSelectSql(name, columns, pk, cursor !== null, batchSize);
      const params = cursor !== null ? [...cursor, batchSize] : [batchSize];
      const res = await withRetry(() => srcPool.query(sql, params), `select ${name}`);
      if (res.rows.length === 0) break;

      // Construire le batch INSERT
      const insertSql = buildInsertSql(name, insertColumns, res.rows.length, conflictTarget, mode);
      const values = [];
      for (const row of res.rows) {
        for (const c of insertColumns) values.push(row[c]);
      }
      const ins = await withRetry(() => dst.query(insertSql, values), `insert ${name}`);
      inserted += ins.rowCount;
      total += res.rows.length;

      // Avance cursor sur la dernière ligne lue
      const last = res.rows[res.rows.length - 1];
      cursor = pk.map(c => last[c]);

      if (res.rows.length < batchSize) break;
    }

    // 2ᵉ passe pour la FK auto-référentielle : UPDATE replaced_by depuis source.
    if (selfRefColumn && total > 0) {
      info(`second pass for self-referential FK`, { table: name, column: selfRefColumn });
      const srcRes = await srcPool.query(
        `SELECT ${pk.map(quoteIdent).join(', ')}, ${quoteIdent(selfRefColumn)}
           FROM ${quoteIdent(name)}
          WHERE ${quoteIdent(selfRefColumn)} IS NOT NULL`,
      );
      let updated = 0;
      for (const row of srcRes.rows) {
        const whereParams = pk.map((c, i) => `${quoteIdent(c)} = $${i + 2}`).join(' AND ');
        const updSql = `UPDATE ${quoteIdent(name)} SET ${quoteIdent(selfRefColumn)} = $1 WHERE ${whereParams}`;
        const params = [row[selfRefColumn], ...pk.map(c => row[c])];
        const u = await dst.query(updSql, params);
        updated += u.rowCount;
      }
      info(`self-ref second pass done`, { table: name, updated });
    }

    await dst.query('COMMIT');
  } catch (err) {
    await dst.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    dst.release();
  }

  return { copied: inserted, total, skipped: false };
}

// ─── Reset des séquences PG ────────────────────────────────────────────────
async function resetSequences(pool, tablesToTouch) {
  // Trouve toutes les séquences attachées à des colonnes des tables migrées.
  // Idempotent : si aucune séquence (cas Opale = UUID partout), no-op.
  const res = await pool.query(`
    SELECT
      n.nspname || '.' || c.relname || '.' || a.attname AS qualified,
      pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) AS seq,
      c.relname AS table_name,
      a.attname AS column_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) IS NOT NULL
      AND c.relname = ANY($1::text[])
  `, [tablesToTouch]);

  if (res.rows.length === 0) {
    info('no sequences detected — nothing to reset');
    return;
  }

  for (const r of res.rows) {
    const setvalSql = `SELECT setval($1, COALESCE((SELECT MAX(${quoteIdent(r.column_name)}) FROM ${quoteIdent(r.table_name)}), 1))`;
    await pool.query(setvalSql, [r.seq]);
    info('sequence reset', { sequence: r.seq, table: r.table_name, column: r.column_name });
  }
}

// ─── Mode --verify ─────────────────────────────────────────────────────────
async function verify(srcPool, dstPool, tablesToCheck) {
  let ok = true;
  for (const t of tablesToCheck) {
    const cfg = getTableConfig(t);
    if (!await tableExists(srcPool, cfg.name)) {
      warn('verify: table missing on source', { table: cfg.name });
      continue;
    }
    if (!await tableExists(dstPool, cfg.name)) {
      error('verify: table missing on target', { table: cfg.name });
      ok = false;
      continue;
    }
    const [srcCount, dstCount] = await Promise.all([
      countRows(srcPool, cfg.name),
      countRows(dstPool, cfg.name),
    ]);
    const status = dstCount >= srcCount ? 'ok' : 'short';
    if (status === 'short') ok = false;
    info('verify', { table: cfg.name, source: srcCount, target: dstCount, status });
  }
  return ok;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const srcDsn = process.env.SOURCE_DSN;
  const dstDsn = process.env.TARGET_DSN;

  if (!srcDsn) throw new Error('SOURCE_DSN env var is required');
  if (!opts.dryRun && !dstDsn) throw new Error('TARGET_DSN env var is required (omit only with --dry-run)');

  const tablesToProcess = opts.tables
    ? opts.tables.map(t => {
        if (!TABLE_NAMES.includes(t)) throw new Error(`Unknown table requested: ${t}`);
        return t;
      })
    : TABLE_NAMES;

  info('migration starting', {
    mode: opts.verify ? 'verify' : (opts.dryRun ? 'dry-run' : 'apply'),
    tables: tablesToProcess.length,
    batchSize: opts.batchSize,
  });

  const srcPool = makePool(srcDsn, 'source');
  const dstPool = dstDsn ? makePool(dstDsn, 'target') : null;

  let exitCode = 0;
  try {
    if (opts.verify) {
      const ok = await verify(srcPool, dstPool, tablesToProcess);
      info('verify completed', { ok });
      exitCode = ok ? 0 : 1;
      return;
    }

    if (opts.dryRun) {
      for (const t of tablesToProcess) {
        if (!await tableExists(srcPool, t)) {
          warn('dry-run: table missing on source', { table: t });
          continue;
        }
        const n = await countRows(srcPool, t);
        info('dry-run: would copy rows', { table: t, source_rows: n });
      }
      return;
    }

    // Mode normal : copie
    const summary = [];
    for (const tName of tablesToProcess) {
      const cfg = getTableConfig(tName);
      const t0 = Date.now();
      info('copying table', { table: tName, conflictTarget: cfg.conflictTarget, mode: cfg.mode || 'skip' });
      try {
        const { copied, total, skipped } = await copyTable(srcPool, dstPool, cfg, opts);
        const ms = Date.now() - t0;
        info('table done', {
          table: tName,
          read: total,
          inserted: copied,
          skipped_existing: total - copied,
          source_missing: skipped,
          duration_ms: ms,
        });
        summary.push({ table: tName, read: total, inserted: copied, ms });
      } catch (err) {
        error('table failed', { table: tName, message: err.message, code: err.code });
        throw err;
      }
    }

    if (opts.resetSeq) {
      info('resetting sequences');
      await resetSequences(dstPool, tablesToProcess);
    } else {
      info('skipping sequence reset (--no-reset-seq)');
    }

    info('migration completed', { tables: summary.length });
  } catch (err) {
    error('migration aborted', { message: err.message, stack: err.stack });
    exitCode = 1;
  } finally {
    await srcPool.end().catch(() => {});
    if (dstPool) await dstPool.end().catch(() => {});
    process.exit(exitCode);
  }
}

main().catch((err) => {
  error('fatal', { message: err.message, stack: err.stack });
  process.exit(1);
});
