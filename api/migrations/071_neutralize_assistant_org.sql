-- Migration 071 : retire le branding d'organisation figé du pre-prompt de
-- l'assistant IA tickets, semé par la migration 067.
--
-- Opale est distribué sous AGPL et auto-hébergé : le pre-prompt semé en 067
-- nommait explicitement une organisation précise, que chaque déployeur tiers
-- envoyait ensuite à SON fournisseur LLM à chaque suggestion. Le nom de
-- l'organisation est déjà un setting (`org.name`), et le code
-- (tickets/lib/assistant.js → buildDefaultSystemPrompt) sait l'injecter :
-- le pre-prompt stocké n'a donc plus à le porter en dur.
--
-- On ne touche QUE la phrase de branding, et seulement si elle est encore
-- exactement celle de 067 : une instance qui a personnalisé son pre-prompt
-- depuis l'UI garde sa version intacte.
--
-- Idempotente : le second passage ne trouve plus la sous-chaîne, replace()
-- est alors un no-op et le WHERE ne matche plus.

UPDATE settings
   SET value = replace(
         value,
         ' L''organisation est la Tour du Valat, un institut de recherche sur les zones humides méditerranéennes.',
         ''
       ),
       updated_at = now()
 WHERE key = 'tickets.assistant.system_prompt'
   AND value LIKE '%L''organisation est la Tour du Valat%';
