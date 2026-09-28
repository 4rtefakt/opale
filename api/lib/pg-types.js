// Parseurs de types node-pg partagés entre le pool applicatif (plugins/db.js)
// et les pools de test (tests/helpers/db.js), pour que les suites voient les
// mêmes valeurs que la prod.
//
// DATE (OID 1082, sans heure) rendue telle quelle ('YYYY-MM-DD') : node-pg la
// transforme sinon en Date locale à minuit, que JSON sérialise en UTC —
// décalée d'un jour dès que le serveur n'est pas en UTC (période d'un point,
// dates d'onboarding).

import pg from 'pg'

export function installPgTypeParsers() {
  pg.types.setTypeParser(1082, v => v)
}
