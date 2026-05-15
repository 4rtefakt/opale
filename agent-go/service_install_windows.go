//go:build windows

package main

import "fmt"

// InstallService — sur Windows, l'installation passe par install.ps1 généré
// au build (cf. agent-go/build.js). On ne duplique pas la logique ACL +
// SCM ici : install.ps1 gère sc.exe create + ACL SYSTEM-only + recovery
// actions, et le binaire de prod est embarqué en B64 dans le script.
func InstallService(token, url string) error {
	return fmt.Errorf("sur Windows, utilisez install.ps1 généré par agent-go/build.js (sc.exe + ACL SYSTEM)")
}

func UninstallService() error {
	return fmt.Errorf("sur Windows, désinstallation manuelle : sc.exe stop <ServiceName> && sc.exe delete <ServiceName>")
}
