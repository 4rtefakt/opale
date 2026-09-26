package main

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// Vérifications statiques des installeurs PowerShell (pas de pwsh en CI) :
// elles protègent le durcissement des templates et la substitution des
// markers ##...## faite par agent-go/build.js et scripts/*.sh.

var installerFiles = []string{"install.ps1", "install-bootstrap-template.ps1", "install-bulk-template.ps1"}

func readInstaller(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("lecture %s : %v", name, err)
	}
	return strings.ReplaceAll(string(raw), "\r\n", "\n")
}

// codeOnly retire les lignes de commentaire PowerShell.
func codeOnly(src string) string {
	var out []string
	for _, l := range strings.Split(src, "\n") {
		if strings.HasPrefix(strings.TrimSpace(l), "#") {
			continue
		}
		out = append(out, l)
	}
	return strings.Join(out, "\n")
}

// Le binaire ne doit plus transiter par $env:TEMP (C:\Windows\Temp en
// SYSTEM, nom prévisible) mais par un nom aléatoire dans le DataDir,
// vérifié (Initialize-DataDir) AVANT tout téléchargement / écriture.
func TestInstallers_BinaryStagedInTrustedDataDir(t *testing.T) {
	for _, f := range installerFiles {
		code := codeOnly(readInstaller(t, f))
		if strings.Contains(strings.ToLower(code), "$env:temp") {
			t.Errorf("%s : utilise encore $env:TEMP", f)
		}
		call := regexp.MustCompile(`(?m)^\s*Initialize-DataDir\s*$`).FindStringIndex(code)
		if call == nil {
			t.Errorf("%s : Initialize-DataDir n'est pas appelé", f)
			continue
		}
		for _, sink := range []string{"Invoke-WebRequest", "WriteAllBytes", "Move-Item"} {
			if i := strings.Index(code, sink); i >= 0 && i < call[0] {
				t.Errorf("%s : %s avant la vérification du DataDir", f, sink)
			}
		}
		if !strings.Contains(code, `$tmpExe = Join-Path $DataDir ("$BinName-" + [guid]::NewGuid().ToString('N') + '.download')`) {
			t.Errorf("%s : fichier temporaire du binaire non aléatoire / hors DataDir", f)
		}
		if !strings.Contains(code, "Set-SystemOnlyAcl $tmpExe $false") {
			t.Errorf("%s : ACL du fichier téléchargé non réinitialisée", f)
		}
		if strings.Contains(code, "Remove-Item") && regexp.MustCompile(`Remove-Item[^\n]*-Recurse`).MatchString(code) {
			t.Errorf("%s : Remove-Item -Recurse suit les jonctions sous PS 5.1", f)
		}
	}
}

// Confiance du DataDir : l'ACL compte (un dossier où un utilisateur a pu
// écrire peut contenir des liens durs), la création est faite avec l'ACL
// SYSTEM-only puis revérifiée, et config.json n'est jamais réécrit en
// place (un lien dur planté serait suivi).
func TestInstallers_DataDirAclAndConfigWrite(t *testing.T) {
	for _, f := range installerFiles {
		code := codeOnly(readInstaller(t, f))
		if !strings.Contains(code, "$acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])") {
			t.Errorf("%s : Test-TrustedItem ne vérifie pas l'ACL", f)
		}
		if !strings.Contains(code, "[System.IO.Directory]::CreateDirectory($Path, $sec)") {
			t.Errorf("%s : DataDir non créé directement avec l'ACL SYSTEM-only", f)
		}
		if !regexp.MustCompile(`Set-SystemOnlyAcl \$DataDir \$true\s+if \(-not \(Test-DataDirTrusted\)\) \{\s+throw`).MatchString(code) {
			t.Errorf("%s : DataDir non revérifié après création", f)
		}
		if strings.Contains(code, "WriteAllText($ConfigPath") {
			t.Errorf("%s : config.json réécrit en place", f)
		}
		if !strings.Contains(code, "Move-Item -LiteralPath $tmpCfg -Destination $ConfigPath -Force") {
			t.Errorf("%s : config.json non écrit via un temporaire + déplacement", f)
		}
	}
}

// build.js remplace la PREMIÈRE occurrence de chaque marker entre quotes :
// elle doit rester l'affectation de la variable correspondante.
func TestInstallPS1_MarkersFirstOccurrenceIsAssignment(t *testing.T) {
	src := readInstaller(t, "install.ps1")
	for _, m := range []string{"AGENT_BIN_B64", "TOKEN", "URL", "SERVICE_NAME", "SERVICE_DISPLAY_NAME",
		"SERVICE_DESCRIPTION", "DATA_DIR_NAME", "BIN_NAME", "LEGACY_SERVICE_NAME"} {
		quoted := "'##" + m + "##'"
		i := strings.Index(src, quoted)
		if i < 0 {
			t.Errorf("marker %s absent", quoted)
			continue
		}
		lineStart := strings.LastIndex(src[:i], "\n") + 1
		if !regexp.MustCompile(`^\$\w+\s*=\s*$`).MatchString(src[lineStart:i]) {
			t.Errorf("1re occurrence de %s n'est pas une affectation : %q", quoted, src[lineStart:i+len(quoted)])
		}
	}
}

// Les scripts shell font un sed global sur ces markers : l'ensemble ne doit
// pas changer (un nouveau marker ne serait jamais substitué).
func TestIntuneTemplates_MarkerSet(t *testing.T) {
	want := map[string][]string{
		"install-bootstrap-template.ps1": {"BIN_NAME", "BOOTSTRAP_TOKEN", "DATA_DIR_NAME", "LEGACY_SCHTASKS_NAME", "SERVICE_NAME", "URL"},
		"install-bulk-template.ps1":      {"BIN_NAME", "DATA_DIR_NAME", "LEGACY_SCHTASKS_NAME", "SERVICE_NAME", "TOKENS_MAP", "URL"},
	}
	re := regexp.MustCompile(`##([A-Z0-9_]+)##`)
	for f, markers := range want {
		seen := map[string]bool{}
		for _, m := range re.FindAllStringSubmatch(readInstaller(t, f), -1) {
			seen[m[1]] = true
		}
		var got []string
		for m := range seen {
			got = append(got, m)
		}
		sort.Strings(got)
		if strings.Join(got, ",") != strings.Join(markers, ",") {
			t.Errorf("%s : markers %v, attendu %v", f, got, markers)
		}
	}
}
