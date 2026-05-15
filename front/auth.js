class Auth {
  constructor() {
    this._app     = null
    this._account = null
  }

  async init() {
    const clientId = window.ENV?.ENTRA_CLIENT_ID
    const tenantId = window.ENV?.ENTRA_TENANT_ID
    if (!clientId || !tenantId) return

    this._app = new msal.PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        redirectUri: window.location.origin
      },
      cache: { cacheLocation: 'localStorage' }
    })

    await this._app.initialize()

    // Gérer le retour après redirect
    const result = await this._app.handleRedirectPromise()
    if (result?.account) {
      this._account = result.account
    } else {
      const accounts = this._app.getAllAccounts()
      if (accounts.length > 0) this._account = accounts[0]
    }

    // Nettoyer le hash OAuth que MSAL laisse dans l'URL (#code=…&state=…)
    // Sans ça, toutes les requêtes fetch partent depuis l'URL avec le code
    if (window.location.hash.includes('code=') || window.location.hash.includes('state=')) {
      window.history.replaceState({}, '', window.location.pathname)
    }
  }

  ready() { return !!this._account }

  async login() {
    if (!this._app) throw new Error('MSAL non initialisé')
    await this._app.loginRedirect({
      scopes: [`api://${window.ENV.ENTRA_CLIENT_ID}/access_as_user`]
    })
  }

  async logout() {
    if (!this._app) return
    await this._app.logoutRedirect()
  }

  async getToken() {
    if (!this._app || !this._account) throw new Error('Non authentifié')
    const req = {
      account: this._account,
      scopes: [`api://${window.ENV.ENTRA_CLIENT_ID}/access_as_user`]
    }
    try {
      const r = await this._app.acquireTokenSilent(req)
      return r.accessToken
    } catch {
      // Ne pas déclencher un redirect si le hash contient encore des params OAuth
      // (évite block_iframe_reload juste après un login redirect)
      if (window.location.hash.includes('code=') || window.location.hash.includes('state=')) {
        throw new Error('Auth en cours — réessayer dans un instant')
      }
      await this._app.acquireTokenRedirect(req)
      // La page va se recharger — on ne revient pas ici
      return new Promise(() => {})
    }
  }

  getUser() {
    if (!this._account) return null
    return {
      entraId:     this._account.localAccountId,
      email:       this._account.username,
      displayName: this._account.name || this._account.username
    }
  }
}

window.auth = new Auth()
