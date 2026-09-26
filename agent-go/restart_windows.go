//go:build windows

package main

// restartService — demande à la boucle de service de quitter pour être
// relancée par le SCM (cf. runServiceLoop / serviceExitRestart). La
// relance repose sur les actions de récupération du service, vérifiées
// (et reposées si besoin) avant de quitter.
//
// Ancienne implémentation : helper détaché « cmd /c timeout /t 5 /nobreak
// >nul && sc stop … && sc start … ». timeout.exe refuse de s'exécuter
// quand son entrée est redirigée (stdin = NUL pour un process lancé par
// os/exec), donc la chaîne && s'arrêtait immédiatement et le service
// n'était jamais relancé : le nouveau binaire ne démarrait qu'au reboot.
//
// La fonction retourne toujours : c'est la boucle de service qui gère la
// sortie. Hors service (--debug / --once), runDebugLoop s'arrête et
// l'opérateur relance l'agent.
func restartService() error {
	requestServiceRestart()
	logf("redémarrage du service demandé")
	return nil
}
