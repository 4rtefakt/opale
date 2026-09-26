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

// psFuncBody — corps d'une fonction PowerShell de premier niveau ("" si absente).
func psFuncBody(code, name string) string {
	i := strings.Index(code, "function "+name)
	if i < 0 {
		return ""
	}
	body := code[i:]
	if j := strings.Index(body, "\n}\n"); j >= 0 {
		body = body[:j]
	}
	return body
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
		// CreateDirectory / New-Item -Force adoptent SANS ERREUR un dossier
		// existant (recréé par un utilisateur qui garde un handle WRITE_DAC) :
		// création sous un nom aléatoire voisin, vérification, puis renommage
		// (qui échoue si le nom a été recréé).
		if strings.Contains(code, "New-SystemOnlyDirectory $DataDir") {
			t.Errorf("%s : DataDir créé directement sur son nom définitif (adoptable)", f)
		}
		iFresh := strings.Index(code, `$fresh = "$DataDir.new-" + [guid]::NewGuid().ToString('N')`)
		iCreate := strings.Index(code, "New-SystemOnlyDirectory $fresh")
		iCheck := strings.Index(code, "if (-not (Test-TrustedItem $fresh))")
		iMove := strings.Index(code, "[System.IO.Directory]::Move($fresh, $DataDir)")
		if iFresh < 0 || !(iFresh < iCreate && iCreate < iCheck && iCheck < iMove) {
			t.Errorf("%s : séquence nom aléatoire → création → vérification → renommage absente (%d %d %d %d)", f, iFresh, iCreate, iCheck, iMove)
		}
		fn := psFuncBody(code, "New-SystemOnlyDirectory")
		if regexp.MustCompile(`New-Item[^\n]*-Force`).MatchString(fn) {
			t.Errorf("%s : repli New-Item -Force (adopterait un dossier existant)", f)
		}
		if !regexp.MustCompile(`(?s)Initialize-DataDir\s*\}\s*catch\s*\{.{0,400}?exit 8`).MatchString(code) {
			t.Errorf("%s : échec du DataDir sans code de sortie 8", f)
		}
		// Nettoyage du dossier temporaire : non récursif et sans invite.
		if !strings.Contains(code, "[System.IO.Directory]::Delete($fresh)") || strings.Contains(code, "Remove-Item -LiteralPath $fresh") {
			t.Errorf("%s : nettoyage de $fresh non fait par [IO.Directory]::Delete", f)
		}

		// Service existant désactivé AVANT d'écarter / recréer le dossier :
		// sinon, course perdue (code 8), le SCM lancerait l'exe planté par
		// l'utilisateur (démarrage, boot, actions de récupération).
		init := psFuncBody(code, "Initialize-DataDir")
		iDisable := strings.Index(init, "Disable-AgentService")
		iAside := strings.Index(init, "[System.IO.Directory]::Move($DataDir, $aside)")
		iNew := strings.Index(init, "New-SystemOnlyDirectory $fresh")
		if iDisable < 0 || !(iDisable < iAside && iDisable < iNew) {
			t.Errorf("%s : service non désactivé avant de toucher au DataDir (%d %d %d)", f, iDisable, iAside, iNew)
		}
		dis := psFuncBody(code, "Disable-AgentService")
		for _, want := range []string{"& sc.exe config $ServiceName start= disabled", "if ($LASTEXITCODE -ne 0) { throw", "WaitForStatus"} {
			if !strings.Contains(dis, want) {
				t.Errorf("%s : Disable-AgentService sans %q", f, want)
			}
		}
		// Les chemins de succès réactivent le service.
		if !strings.Contains(code, "binPath= \"`\"$ExePath`\"\" start= auto") {
			t.Errorf("%s : le chemin de succès ne repasse pas le service en start= auto", f)
		}
		if f == "install.ps1" {
			// Seules relances : la fin d'installation réussie et
			// Restore-AgentService (dossier de confiance + ImagePath exact).
			if n := strings.Count(code, "Start-Service"); n != 2 {
				t.Errorf("%s : %d Start-Service, attendu 2 (succès + Restore-AgentService)", f, n)
			}
			rs := psFuncBody(code, "Restore-AgentService")
			iCond := strings.Index(rs, "if ((Test-DataDirTrusted) -and ($image -ieq $ExePath) -and (Test-TrustedItem $ExePath))")
			if iCond < 0 || iCond > strings.Index(rs, "Start-Service") {
				t.Errorf("%s : Restore-AgentService relance sans vérifier dossier et ImagePath", f)
			}
			if strings.Count(code, "    Restore-AgentService\n") != 2 {
				t.Errorf("%s : les chemins d'échec doivent passer par Restore-AgentService", f)
			}
		} else {
			// Templates : aucun démarrage hors du chemin de succès, et la tâche
			// planifiée héritée (qui exécute un script du dossier) est retirée.
			if strings.Contains(code, "Start-Service") || strings.Count(code, "sc.exe start") != 1 {
				t.Errorf("%s : démarrage du service hors du chemin de succès", f)
			}
			if !strings.Contains(dis, "Remove-LegacyScheduledTask") {
				t.Errorf("%s : tâche planifiée héritée non retirée avant de toucher au DataDir", f)
			}
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

// Les scripts de build font un sed GLOBAL sur les markers (et, pour
// TOKENS_MAP, remplacent toute la ligne par la table des tokens) : chaque
// marker ne doit apparaître qu'une fois, sur sa ligne d'affectation, sinon
// la table est injectée en double (script non analysable) ou une
// comparaison au marker devient toujours fausse.
func TestIntuneTemplates_MarkersOnlyAtAssignment(t *testing.T) {
	re := regexp.MustCompile(`##([A-Z0-9_]+)##`)
	for _, f := range []string{"install-bootstrap-template.ps1", "install-bulk-template.ps1"} {
		src := readInstaller(t, f)
		count := map[string]int{}
		for _, m := range re.FindAllStringSubmatch(src, -1) {
			count[m[1]]++
		}
		for m, n := range count {
			if m == "TOKENS_MAP" {
				// Ligne entière remplacée par la table : une seule occurrence
				// dans tout le fichier, seule sur sa ligne.
				if n != 1 || !regexp.MustCompile(`(?m)^##TOKENS_MAP##$`).MatchString(src) {
					t.Errorf("%s : ##TOKENS_MAP## présent %d fois (la règle sed r/d injecterait la table %d fois)", f, n, n)
				}
				continue
			}
			// Les commentaires d'en-tête peuvent citer les autres markers
			// (valeur recopiée dans le commentaire, sans effet).
			code := strings.Count(codeOnly(src), "##"+m+"##")
			if code != 1 {
				t.Errorf("%s : ##%s## présent %d fois dans le code, attendu 1 (affectation)", f, m, code)
			}
		}
	}
}
