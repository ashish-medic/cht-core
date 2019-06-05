const taskUtils = require('@medic/task-utils');
const db = require('../db');
const logger = require('../logger');
const config = require('../config');
const africasTalking = require('./africas-talking');
const recordUtils = require('../controllers/record-utils');

const DB_CHECKING_INTERVAL = 1000*60*5; // Check DB for messages every 5 minutes
const SMS_SENDING_SERVICES = {
  'africas-talking': africasTalking
  // sms-gateway -- ignored because it's a pull not a push service
};

const getTaskFromMessage = (tasks, uuid) => {
  return tasks && tasks.find(task => {
    return task.messages && task.messages.find(message => uuid === message.uuid);
  });
};

const getTaskForMessage = (uuid, doc) => {
  return getTaskFromMessage(doc.tasks, uuid) ||
         getTaskFromMessage(doc.scheduled_tasks, uuid);
};

const getTaskAndDocForMessage = (messageId, docs) => {
  for (const doc of docs) {
    const task = getTaskForMessage(messageId, doc);
    if (task) {
      return { task: task, docId: doc._id };
    }
  }
  return {};
};

/*
 * Applies (in-place) state changes to a given collection of docs.
 *
 * Also returns a map of docId -> taskStateChanges
*/
const applyTaskStateChangesToDocs = (taskStateChanges, docs) => {
  return taskStateChanges.reduce((memo, change) => {
    if (!change.messageId) {
      logger.error(`Message id required: ${JSON.stringify(change)}`);
    } else {
      const { task, docId } = getTaskAndDocForMessage(change.messageId, docs);
      if (!task) {
        logger.error(`Message not found: ${change.messageId}`);
      } else {
        if (taskUtils.setTaskState(task, change.state, change.details, change.gateway_ref)) {
          if (!memo[docId]) {
            memo[docId] = [];
          }
          memo[docId].push(change);
        }
      }
    }
    return memo;
  }, {});
};

const getOutgoingMessageService = () => {
  const settings = config.get('sms');
  return settings &&
         settings.outgoing_service &&
         SMS_SENDING_SERVICES[settings.outgoing_service];
};

const checkDbForMessagesToSend = () => {
  const service = getOutgoingMessageService();
  if (!service) {
    return Promise.resolve();
  }
  return module.exports.getOutgoingMessages().then(messages => {
    if (!messages.length) {
      return;
    }
    return sendMessages(service, messages);
  });
};

const getPendingMessages = doc => {
  const tasks = [].concat(doc.tasks || [], doc.scheduled_tasks || []);
  return tasks.reduce((memo, task) => {
    if (task.messages) {
      task.messages.forEach(msg => {
        if (
          msg.uuid &&
          msg.to &&
          msg.message &&
          (task.state === 'pending' || task.state === 'forwarded-to-gateway')
        ) {
          memo.push({
            content: msg.message,
            to: msg.to,
            id: msg.uuid,
          });
        }
      });
    }
    return memo;
  }, []);
};

const sendMessages = (service, messages) => {
  if (!messages.length) {
    return;
  }
  return service.send(messages).then(responses => {
    const stateUpdates = messages
      .map((message, i) => {
        const response = responses[i];
        if (response.success) {
          return {
            messageId: message.id,
            state: response.state,
            gateway_ref: response.gateway_ref
          };
        }
      })
      .filter(update => update); // ignore failed updates
    if (stateUpdates.length) {
      return module.exports.updateMessageTaskStates(stateUpdates);
    }
  });
};

const validateRequiredFields = messages => {
  const requiredFields = [ 'id', 'content', 'from' ];
  return messages.filter(message => {
    return requiredFields.every(field => {
      if (!message[field]) {
        logger.info(`Message missing required field "${field}": ${JSON.stringify(message)}`);
      } else {
        return true;
      }
    });
  });
};

const removeDuplicateMessages = messages => {
  if (!messages.length) {
    return Promise.resolve([]);
  }
  const keys = messages.map(message => message.id);
  return db.medic.query('medic-sms/messages_by_gateway_ref', { keys })
    .then(res => res.rows.map(row => row.key))
    .then(seenIds => messages.filter(message => {
      if (seenIds.includes(message.id)) {
        logger.info(`Ignoring message (ID already seen): "${message.id}"`);
      } else {
        return true;
      }
    }));
};

const validateIncomingMessages = messages => {
  return removeDuplicateMessages(validateRequiredFields(messages));
};

const createDocs = messages => {
  if (!messages.length) {
    return [];
  }
  const docs = messages.map(message => recordUtils.createByForm({
    from: message.from,
    message: message.content,
    gateway_ref: message.id,
  }));
  return config.getTransitionsLib().processDocs(docs);
};

module.exports = {
  
  /**
   * Sends pending messages on the doc with the given ID using the
   * configured outgoing message service.
   */
  send: docId => {
    const service = getOutgoingMessageService();
    if (!service) {
      return Promise.resolve();
    }
    return db.medic.get(docId).then(doc => {
      return sendMessages(service, getPendingMessages(doc));
    });
  },

  /**
   * Stores incoming messages in the database.
   * @param messages an array of message objects with properties
   *    - id: unique gateway reference used to prevent double handling
   *    - from: the phone number of the original sender
   *    - content: the string message
   */
  processIncomingMessages: (messages=[]) => {
    return validateIncomingMessages(messages)
      .then(messages => createDocs(messages))
      .then(results => {
        const allOk = results.every(result => result.ok);
        if (!allOk) {
          logger.error('Failed saving all the new docs: %o', results);
          throw new Error('Failed saving all the new docs');
        }
      });
  },

  /*
   * Returns `options.limit` messages, optionally filtering by state.
   */
  getOutgoingMessages: () => {
    const viewOptions = {
      limit: 100,
      startkey: [ 'pending-or-forwarded', 0 ],
      endkey: [ 'pending-or-forwarded', '\ufff0' ],
    };
    return db.medic.query('medic-sms/messages_by_state', viewOptions)
      .then(response => response.rows.map(row => row.value));
  },
  /*
   * taskStateChanges: an Array of objects with
   *   - messageId
   *   - state
   *   - details (optional)
   *   - gateway_ref (optional)
   *
   * These state updates are prone to failing due to update conflicts, so this
   * function will retry up to three times for any updates which fail.
   */
  updateMessageTaskStates: (taskStateChanges, retriesLeft=3) => {
    const options = { keys: taskStateChanges.map(change => change.messageId) };
    return db.medic.query('medic-sms/messages_by_uuid', options)
      .then(results => {
        const uniqueIds = [...new Set(results.rows.map(row => row.id))];
        return db.medic.allDocs({ keys: uniqueIds, include_docs: true });
      })
      .then(results => {
        const docs = results.rows.map(r => r.doc);
        const stateChangesByDocId = applyTaskStateChangesToDocs(taskStateChanges, docs);
        const updated = docs.filter(doc => stateChangesByDocId[doc._id] && stateChangesByDocId[doc._id].length);

        if (!updated.length) {
          // nothing to update
          return;
        }
        return db.medic.bulkDocs(updated).then(results => {
          const failures = results.filter(result => !result.ok);
          if (!failures.length) {
            // all successful
            return;
          }

          if (!retriesLeft) {
            // at least one failed and we've run out of retries - give up!
            return Promise.reject(new Error(`Failed to updateMessageTaskStates: ${JSON.stringify(failures)}`));
          }

          logger.warn(`Problems with updateMessageTaskStates: ${JSON.stringify(failures)}\nRetrying ${retriesLeft} more times.`);

          const relevantChanges = [];
          failures.forEach(failure => {
            relevantChanges.push(...stateChangesByDocId[failure.id]);
          });
          return module.exports.updateMessageTaskStates(relevantChanges, --retriesLeft);
        });
      });
  },
  /**
   * Returns true if the configured outgoing messaging service is set
   * to "medic-gateway". We don't want to get into the situation of
   * two services sending the same message.
   */
  isMedicGatewayEnabled: () => {
    const settings = config.get('sms') || {};
    return settings.outgoing_service === 'medic-gateway';
  }
  
};

if (process.env.UNIT_TEST_ENV) {
  module.exports._checkDbForMessagesToSend = checkDbForMessagesToSend;
} else {
  setInterval(checkDbForMessagesToSend, DB_CHECKING_INTERVAL);
}