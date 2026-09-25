const QUICK_CMDS = [
  { label: 'ipconfig',     cmd: 'ipconfig /all' },
  { label: 'gpupdate',     cmd: 'gpupdate /force' },
  { label: 'whoami',       cmd: 'whoami /all' },
  { label: 'event log',    cmd: 'Get-EventLog -LogName System -Newest 10 | Format-Table -AutoSize' },
  { label: 'services',     cmd: 'Get-Service | Where-Object {$_.Status -eq "Stopped"} | Format-Table -AutoSize' },
  { label: 'disk',         cmd: 'Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize' },
  { label: 'processes',    cmd: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 | Format-Table -AutoSize' },
  { label: 'restart',      cmd: 'Restart-Computer -Force' },
  { label: 'hostname',     cmd: 'hostname' },
  { label: 'uptime',       cmd: '(Get-Date) - (gcim Win32_OperatingSystem).LastBootUpTime' },
]

const HISTORY_KEY = (id) => `ssh-history-${id}`
const MAX_HISTORY = 50

let _ws        = null
let _output    = ''
let _deviceId  = null
let _escapeBuf = ''  // fragment d'escape sequence coupé entre deux chunks

export function renderSSH(el, id) {
  _ws        = null
  _output    = ''
  _deviceId  = id
  _escapeBuf = ''

  el.innerHTML = `
    <div class="m-ssh-bar">
      <button class="m-icon-btn" style="background:#1a1a1a;color:#94a3b8" onclick="mSSHDisconnect()">
        <i class="ti ti-x"></i>
      </button>
      <div style="flex:1;min-width:0">
        <span id="m-ssh-status" class="m-ssh-status">Connexion…</span>
        <span id="m-ssh-host" style="font-size:10px;color:#555;margin-left:8px"></span>
      </div>
      <button class="m-ssh-key-btn" onclick="mSSHShowHistory()" title="Historique">
        <i class="ti ti-history"></i>
      </button>
    </div>

    <!-- Commandes rapides -->
    <div class="m-ssh-quick-row" id="m-ssh-quick-row">
      ${QUICK_CMDS.map((c, i) => `
        <button class="m-ssh-quick-btn" data-idx="${i}">${esc(c.label)}</button>
      `).join('')}
    </div>

    <div id="m-ssh-out" class="m-ssh-out"><span id="m-ssh-end"></span></div>

    <div class="m-ssh-input-row">
      <button class="m-ssh-key-btn" onclick="mSSHSendRaw('\t')">Tab</button>
      <button class="m-ssh-key-btn" onclick="mSSHSendRaw('\x03')">^C</button>
      <input class="m-ssh-input" id="m-ssh-in" autocomplete="off" autocorrect="off"
        autocapitalize="none" spellcheck="false" placeholder="Commande…"
        onkeydown="mSSHKeyDown(event)">
      <button class="m-ssh-send-btn" onclick="mSSHSend()">
        <i class="ti ti-arrow-up"></i>
      </button>
    </div>`

  document.getElementById('m-ssh-quick-row')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-idx]')
    if (btn) mSSHExec(QUICK_CMDS[+btn.dataset.idx].cmd)
  })

  window.mSSHDisconnect  = () => {
    _ws?.close(); _ws = null
    // Retour explicite au détail du poste (robuste sur deep-link / refresh PWA)
    window.location.hash = _deviceId ? '#/poste/' + _deviceId : '#/postes'
  }
  window.mSSHSend        = mSSHSend
  window.mSSHSendRaw     = mSSHSendRaw
  window.mSSHInsert      = mSSHInsert
  window.mSSHExec        = mSSHExec
  window.mSSHKeyDown     = mSSHKeyDown
  window.mSSHShowHistory = mSSHShowHistory

  connectSSH(id)
}

async function connectSSH(id) {
  // Motif obligatoire (RGPD / traçabilité) : POST /api/ssh/grant répond 400
  // sans { category, note }. Annulation → retour à la fiche poste.
  let host = ''
  try { host = (await window.api.getDevice(id))?.hostname || '' } catch {}
  const reason = await mPromptRemoteReason(host)
  if (!reason) {
    // Pas de redirection si l'utilisateur a déjà quitté cet écran SSH.
    if (_deviceId === id && window.location.hash.startsWith('#/ssh/')) window.mSSHDisconnect()
    return
  }

  let nonce
  try {
    ({ nonce } = await window.api.requestSshGrant(id, reason))
  } catch (err) {
    setStatus('Erreur autorisation', false)
    appendOutput('\n⚠ ' + (err.message || 'Refus autorisation SSH') + '\n')
    return
  }
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws'
  const wsUrl   = `${wsProto}://${location.host}/api/ssh/${encodeURIComponent(id)}?nonce=${encodeURIComponent(nonce)}`

  _ws = new WebSocket(wsUrl)
  _ws.onopen    = () => setStatus('Connecté', true)
  _ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'data') {
      const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0))
      appendOutput(new TextDecoder().decode(bytes))
    }
    else if (msg.type === 'status') {
      const el = document.getElementById('m-ssh-host')
      if (el) el.textContent = msg.data
    } else if (msg.type === 'error') {
      appendOutput('\n⚠ ' + msg.data + '\n')
      setStatus('Erreur', false)
    }
  }
  _ws.onclose = () => { setStatus('Déconnecté', false); appendOutput('\n[Connexion fermée]\n') }
  _ws.onerror = () => setStatus('Erreur WebSocket', false)
}

// Saisie du motif d'ouverture de session : même contrat, mêmes libellés et
// même mémorisation de la catégorie que promptRemoteReason() du desktop
// (views/poste.js), présentés dans la feuille mobile. Résout
// { category, note } si validé, null si annulé (bouton ou tap hors feuille).
const REASON_CATEGORIES  = ['maintenance', 'troubleshoot', 'audit', 'incident', 'other']
const REASON_STORAGE_KEY = 'remote-reason-last-category'

function mPromptRemoteReason(hostname) {
  return new Promise(resolve => {
    let lastCat = 'troubleshoot'
    try { lastCat = localStorage.getItem(REASON_STORAGE_KEY) || lastCat } catch {}
    window.mShowSheet(`
      <div class="m-sheet-title"><i class="ti ti-shield-lock" style="margin-right:6px"></i>${esc(t('remote.reason.title_ssh', { host: hostname }))}</div>
      <div style="display:flex;flex-direction:column;gap:12px;padding:0 4px">
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">${esc(t('remote.reason.warn_ssh'))}</div>
        <div>
          <div class="m-label">${esc(t('remote.reason.category_label'))}</div>
          <select class="m-input" id="m-rr-cat">
            ${REASON_CATEGORIES.map(c => `<option value="${c}" ${c === lastCat ? 'selected' : ''}>${esc(t('remote.reason.cat.' + c))}</option>`).join('')}
          </select>
        </div>
        <div>
          <div class="m-label">${esc(t('remote.reason.note_label'))}</div>
          <textarea class="m-input" id="m-rr-note" rows="3" maxlength="500" style="resize:none"
            placeholder="${esc(t('remote.reason.note_placeholder'))}"></textarea>
          <div id="m-rr-err" style="color:var(--red);font-size:11px;margin-top:4px;display:none"></div>
        </div>
        <button class="m-btn-primary" id="m-rr-ok">${esc(t('remote.reason.open'))}</button>
        <button id="m-rr-cancel" style="width:100%;padding:10px;border-radius:10px;font-size:13px;font-weight:500;background:none;border:1px solid var(--border);color:var(--text-secondary);cursor:pointer">
          ${esc(t('btn.cancel'))}
        </button>
      </div>`)

    const overlay = document.getElementById('m-sheet-overlay')
    let done = false
    const finish = (val) => {
      if (done) return
      done = true
      obs.disconnect()
      resolve(val)
    }
    // La feuille se ferme aussi sur tap hors de celle-ci (mCloseSheet) : vaut annulation.
    const obs = new MutationObserver(() => { if (!overlay.classList.contains('open')) finish(null) })
    obs.observe(overlay, { attributes: true, attributeFilter: ['class'] })

    document.getElementById('m-rr-cancel').onclick = () => { finish(null); window.mCloseSheet() }
    document.getElementById('m-rr-ok').onclick = () => {
      const category = document.getElementById('m-rr-cat').value
      const note     = document.getElementById('m-rr-note').value.trim()
      if (note.length < 5) {
        const err = document.getElementById('m-rr-err')
        err.textContent   = t('remote.reason.err_too_short')
        err.style.display = 'block'
        return
      }
      try { localStorage.setItem(REASON_STORAGE_KEY, category) } catch {}
      finish({ category, note })
      window.mCloseSheet()
    }
  })
}

function mSSHSend() {
  const inp = document.getElementById('m-ssh-in')
  if (!inp) return
  const cmd = inp.value
  if (!cmd) return
  inp.value = ''
  pushHistory(cmd)
  mSSHSendRaw(cmd + '\r')
}

function mSSHSendRaw(data) {
  if (_ws?.readyState === WebSocket.OPEN) {
    // Encoder correctement les caractères UTF-8
    const bytes = new TextEncoder().encode(data)
    const b64   = btoa(String.fromCharCode(...bytes))
    _ws.send(JSON.stringify({ type: 'input', data: b64 }))
  }
}

function mSSHInsert(cmd) {
  const inp = document.getElementById('m-ssh-in')
  if (!inp) return
  inp.value = cmd
  inp.focus()
  inp.setSelectionRange(cmd.length, cmd.length)
}

function mSSHExec(cmd) {
  pushHistory(cmd)
  mSSHSendRaw(cmd + '\r')
}

function mSSHKeyDown(e) {
  if (e.key === 'Enter') { e.preventDefault(); mSSHSend() }
  else if (e.key === 'ArrowUp') {
    e.preventDefault()
    const hist = getHistory()
    const inp  = document.getElementById('m-ssh-in')
    if (!inp || !hist.length) return
    const cur = hist.findIndex(c => c === inp.value)
    const idx  = cur <= 0 ? hist.length - 1 : cur - 1
    inp.value  = hist[idx]
  }
  else if (e.key === 'ArrowDown') {
    e.preventDefault()
    const hist = getHistory()
    const inp  = document.getElementById('m-ssh-in')
    if (!inp || !hist.length) return
    const cur = hist.findIndex(c => c === inp.value)
    if (cur === -1 || cur >= hist.length - 1) inp.value = ''
    else inp.value = hist[cur + 1]
  }
}

function mSSHShowHistory() {
  const hist = getHistory().slice().reverse()
  if (!hist.length) { window.showToast('Aucun historique', 'info'); return }
  window.mShowSheet(`
    <div class="m-sheet-title"><i class="ti ti-history"></i> Historique de commandes</div>
    <div style="display:flex;flex-direction:column">
      ${hist.map((cmd, i) => `
        <button onclick="mSSHInsertFromHistory(${i})"
          style="text-align:left;padding:10px 16px;border:none;border-bottom:0.5px solid var(--border);
                 background:none;color:var(--text-primary);font-family:monospace;font-size:12px;cursor:pointer">
          ${esc(cmd)}
        </button>`).join('')}
      <button onclick="mSSHClearHistory()"
        style="padding:12px 16px;border:none;background:none;color:var(--red);font-size:13px;cursor:pointer;margin-top:4px">
        <i class="ti ti-trash"></i> Effacer l'historique
      </button>
    </div>`)

  const reversedHist = hist
  window.mSSHInsertFromHistory = (i) => {
    window.mCloseSheet()
    mSSHInsert(reversedHist[i])
  }
  window.mSSHClearHistory = () => {
    if (_deviceId) localStorage.removeItem(HISTORY_KEY(_deviceId))
    window.mCloseSheet()
    window.showToast('Historique effacé', 'success')
  }
}

function pushHistory(cmd) {
  if (!cmd || !_deviceId) return
  const key  = HISTORY_KEY(_deviceId)
  const hist = JSON.parse(localStorage.getItem(key) || '[]')
  const filtered = hist.filter(c => c !== cmd) // déduplique
  filtered.push(cmd)
  if (filtered.length > MAX_HISTORY) filtered.splice(0, filtered.length - MAX_HISTORY)
  localStorage.setItem(key, JSON.stringify(filtered))
}

function getHistory() {
  if (!_deviceId) return []
  return JSON.parse(localStorage.getItem(HISTORY_KEY(_deviceId)) || '[]')
}

function appendOutput(raw) {
  // Réassembler avec le fragment incomplet du chunk précédent
  raw = _escapeBuf + raw
  // Sauvegarder un éventuel début de séquence ESC en fin de chunk
  const tail = raw.match(/\x1b[^\x1b]*$/)
  if (tail) {
    _escapeBuf = tail[0]
    raw = raw.slice(0, raw.length - tail[0].length)
  } else {
    _escapeBuf = ''
  }

  const clean = raw
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')             // CSI (y compris ?25h, ?2004h…)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')  // OSC
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')            // DCS / SOS / PM / APC
    .replace(/\x1b[()][AB012]/g, '')                      // charset
    .replace(/\x1b./g, '')                                // ESC + 1 char restants
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')

  const sentinel = document.getElementById('m-ssh-end')
  if (!sentinel) return

  _output += clean
  if (_output.length > 20000) {
    _output = _output.slice(-20000)
    sentinel.parentElement.textContent = _output
    sentinel.parentElement.appendChild(sentinel)
  } else if (clean) {
    sentinel.insertAdjacentText('beforebegin', clean)
  }
  sentinel.scrollIntoView({ block: 'end' })
}

function setStatus(text, ok) {
  const el = document.getElementById('m-ssh-status')
  if (!el) return
  el.textContent = text
  el.style.color = ok === true ? 'var(--green)' : ok === false ? 'var(--red)' : 'var(--amber)'
}
