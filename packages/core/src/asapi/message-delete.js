import {appendSessionEvent, projectSessionEvents} from './session-events.js';
import {saveSessionRecord} from './store.js';

/** Delete one displayed bubble durably; executed tools and agent checkpoints are not rolled back. */
export function deleteDisplayedMessage(record, messageId) {
 if (record.deleted_message_ids?.includes(messageId)) return true;
 const message = record.display?.find(item => item.id === messageId);
 if (!message || !['user', 'assistant'].includes(message.role)) return false;
 const event = appendSessionEvent(record.id, 'message-deleted', {message_id:messageId});
 projectSessionEvents(record, [event]);
 saveSessionRecord(record);
 return true;
}
