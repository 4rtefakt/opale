// Dépôt de flotte upstream de test pour le miroir git du module linux.
//
// Crée dans un dossier temporaire : un HOME vide (aucun ~/.gitconfig du
// développeur), deux clés SSH (signataire autorisé + inconnu), un dépôt bare
// `upstream.git` et un clone de travail qui y pousse des commits signés ou non.
// Tout tourne avec le vrai `git` local, sans réseau.

import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execFile = promisify(execFileCb)

export async function createFleetRepo() {
  const root = await mkdtemp(join(tmpdir(), 'opale-fleet-'))
  const home = join(root, 'home')
  const upstream = join(root, 'upstream.git')
  const work = join(root, 'work')
  await mkdir(home)
  const env = { PATH: process.env.PATH, HOME: home, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }
  const git = async (args, { cwd = work } = {}) => (await execFile('git', args, { cwd, env })).stdout.trimEnd()
  const keygen = name => execFile('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', join(root, name)], { env })
  await Promise.all([keygen('signer'), keygen('stranger')])
  const signerLine = async name => {
    const [type, key] = (await readFile(join(root, `${name}.pub`), 'utf8')).split(' ')
    return `${name} ${type} ${key}`
  }
  await git(['init', '-q', '--bare', '-b', 'main', upstream], { cwd: root })
  await git(['init', '-q', '-b', 'main', work], { cwd: root })
  for (const [key, value] of [
    ['user.name', 'Flotte Test'], ['user.email', 'flotte@test.local'],
    ['gpg.format', 'ssh'], ['user.signingkey', join(root, 'signer.pub')], ['commit.gpgsign', 'false'],
  ]) await git(['config', key, value])
  await git(['remote', 'add', 'origin', upstream])

  let counter = 0
  const repo = {
    root, home, env,
    url: `file://${upstream}`,
    allowedSigners: [await signerLine('signer')],
    strangerSigners: [await signerLine('stranger')],
    git,
    // Commit sur la branche courante du clone de travail, poussé sur upstream ; renvoie le sha.
    async commit({ message = `commit ${++counter}`, signed = true, key = 'signer', files = {} } = {}) {
      for (const [path, content] of Object.entries(files)) {
        await mkdir(join(work, path, '..'), { recursive: true })
        await writeFile(join(work, path), content)
      }
      await git(['add', '-A'])
      const args = signed ? ['-c', `user.signingkey=${join(root, `${key}.pub`)}`, 'commit', '-q', '-S'] : ['commit', '-q', '--no-gpg-sign']
      await git([...args, '--allow-empty', '-m', message])
      const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
      await git(['push', '-q', 'origin', branch])
      return git(['rev-parse', 'HEAD'])
    },
    // Crée (ou bascule sur) une branche ; `from` = point de départ.
    async checkout(branch, { from } = {}) {
      await git(from ? ['checkout', '-q', '-B', branch, from] : ['checkout', '-q', branch])
    },
    async cleanup() { await rm(root, { recursive: true, force: true }) },
  }
  return repo
}
