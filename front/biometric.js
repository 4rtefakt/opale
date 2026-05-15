// Verrouillage biométrique local via WebAuthn (vérification côté appareil uniquement)
// Ne remplace pas l'auth Azure AD — sert de verrou d'app après inactivité.

const CRED_KEY     = 'rmm-bio-cred'
const LAST_KEY     = 'rmm-bio-last'
const LOCK_TIMEOUT = 10 * 60 * 1000 // 10 min d'inactivité

export function isSupported() {
  return !!window.PublicKeyCredential && !!navigator.credentials?.create
}

export function isEnabled() {
  return !!localStorage.getItem(CRED_KEY)
}

/** Enregistrer une nouvelle empreinte biométrique. */
export async function register() {
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp:   { name: window.ENV?.BRANDING?.product_name || 'RMM', id: location.hostname },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'admin', displayName: 'Admin RMM' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7   }, // ES256
          { type: 'public-key', alg: -257 }  // RS256
        ],
        authenticatorSelection: { userVerification: 'required', requireResidentKey: false },
        timeout: 60000
      }
    })
    const rawIdB64 = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)))
    localStorage.setItem(CRED_KEY, rawIdB64)
    touch()
    return true
  } catch (err) {
    console.warn('bio register:', err.message)
    return false
  }
}

/** Vérifier l'empreinte. Retourne true si succès. */
export async function verify() {
  const credIdB64 = localStorage.getItem(CRED_KEY)
  if (!credIdB64) return true // pas activé → ok
  const credId    = Uint8Array.from(atob(credIdB64), c => c.charCodeAt(0))
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  try {
    await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ type: 'public-key', id: credId }],
        userVerification: 'required',
        timeout: 60000
      }
    })
    touch()
    return true
  } catch {
    return false
  }
}

/** Enregistrer le moment de la dernière interaction. */
export function touch() {
  localStorage.setItem(LAST_KEY, String(Date.now()))
}

/** L'app doit-elle être verrouillée ? */
export function shouldLock() {
  if (!isEnabled()) return false
  const last = parseInt(localStorage.getItem(LAST_KEY) || '0')
  return Date.now() - last > LOCK_TIMEOUT
}

/** Désactiver le verrou biométrique. */
export function disable() {
  localStorage.removeItem(CRED_KEY)
  localStorage.removeItem(LAST_KEY)
}
