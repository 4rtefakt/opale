// Seeds réutilisables pour les tables packages, deployment_jobs, deployments.

// Insère un package minimal. status='approved' par défaut pour les tests
// de déploiement — surcharger avec { status: 'draft' } si besoin.
export async function insertPackage(db, {
  name = 'Test Package',
  type = 'winget',
  wingetId = 'Test.Package',
  status = 'approved',
  createdBy = null,
} = {}) {
  const r = await db.query(
    `INSERT INTO packages (name, type, winget_id, status, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [name, type, wingetId, status, createdBy]
  )
  return r.rows[0]
}

// Insère un deployment_job (scope group|all|user|native_group).
export async function insertDeploymentJob(db, {
  packageId,
  scope = 'all',
  sourceGroupId = null,
  nativeGroupId = null,
  userEntraId = null,
  deployedBy = null,
  status = 'active',
} = {}) {
  const r = await db.query(
    `INSERT INTO deployment_jobs (package_id, scope, source_group_id, native_group_id, user_entra_id, deployed_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [packageId, scope, sourceGroupId, nativeGroupId, userEntraId, deployedBy, status]
  )
  return r.rows[0]
}

// Insère un deployment direct (job_id optionnel).
export async function insertDeployment(db, {
  packageId,
  deviceId,
  deployedBy = null,
  jobId = null,
  status = 'pending',
} = {}) {
  const r = await db.query(
    `INSERT INTO deployments (package_id, device_id, deployed_by, job_id, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [packageId, deviceId, deployedBy, jobId, status]
  )
  return r.rows[0]
}
