const config = require('../config');
const later = require('later');
const db = require('../db');
const logger = require('../lib/logger');
const rpn = require('request-promise-native');

let timers = [];

// set later to use local time
later.date.localTime();

function isConfigValid(config) {
  // Failing parsing will throw an Error
  try {
    return Boolean(
      config.fromSuffix &&
      config.toSuffix &&
      getSchedule(config) !== null
    );
  } catch(e) {
    return false;
  }
}

function getSchedule(config) {
  // fetch a schedule based on the configuration, parsing it as a "cron"
  // or "text" statement see:
  // http://bunkat.github.io/later/parsers.html
  if (!config) {
    return;
  }
  if (config.text_expression) {
    // text expression takes precedence over cron
    return later.parse.text(config.text_expression);
  }
  if (config.cron) {
    return later.parse.cron(config.cron);
  }
}

const purgeDocs = (sourceDb, docs) => {
  if (!docs || !docs.length) {
    return Promise.resolve();
  }

  const docsToPurge = {};
  docs.forEach(doc => docsToPurge[doc._id] = [doc._rev]);

  return sourceDb
    .info()
    .then(info => {
      const opts = {
        uri: `${db.serverUrl}/${info.db_name}/_purge`,
        json: true,
        body: docsToPurge,
      };

      return rpn.post(opts);
    });
};

function replicateDb(sourceDb, targetDb) {
  // Replicate only telemetry and feedback docs
  return sourceDb.replicate
    .to(targetDb, {
      filter: doc => !doc._deleted && (doc._id.startsWith('telemetry-') || doc._id.startsWith('feedback-'))
    })
    .on('change', changes => {
      return purgeDocs(sourceDb, changes.docs);
    })
    .catch(err => {
      logger.error('Error while replicating: %o', err);
    });
}

module.exports = {
  execute: callback => {
    const replications = config.get('replications') || [];

    // Clear existing timers
    timers.forEach(timer => timer.clear());
    timers = [];

    replications.reduce((p, replication) => {
      if (!isConfigValid(replication)) {
        throw new Error(
          `Invalid replication config with fromSuffix = '${replication.fromSuffix}', ` +
          `toSuffix = '${replication.toSuffix}', text expression = '${replication.text_expression}' and ` +
          `cron = '${replication.cron}'
        `);
      }

      const sched = getSchedule(replication);

      return p.then(() => {
        const timer = later.setInterval(() => module.exports.runReplication(replication), sched);
        timers.push(timer);
        return Promise.resolve();
      });
    }, Promise.resolve())
      .then(() => callback())
      .catch(callback);
  },
  runReplication: replication => {
    const srcRegex = new RegExp(`${db.medicDbName}-${replication.fromSuffix}`);

    const toDb = `${db.medicDbName}-${replication.toSuffix}`;
    return db.allDbs().then(dbs => {
      const srcDbs = dbs.filter(db => srcRegex.exec(db));
      return module.exports.replicateDbs(srcDbs, toDb);
    });
  },
  replicateDbs: (fromDbs, toDb) => {
    const targetDb = db.get(toDb);
    return fromDbs
      .reduce((p, fromDb) => {
        logger.info(`Replicating docs from "${fromDb}" to "${toDb}"`);
        const sourceDb = db.get(fromDb);
        return p
          .then(() => replicateDb(sourceDb, targetDb))
          .then(() => db.close(sourceDb));
      }, Promise.resolve()
      )
      .then(() => db.close(targetDb));
  },
};
