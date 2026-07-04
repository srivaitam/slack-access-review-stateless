const { slack } = require('../slack/client');

async function sendRevocationNotification({ userId, userName, channelIds, reason }) {
  try {
    const dm = await slack.conversations.open({ users: userId });
    const channelNames = await Promise.all(
      channelIds.slice(0, 10).map(async channelId => {
        try {
          const info = await slack.conversations.info({ channel: channelId });
          return info.channel.name;
        } catch { return channelId; }
      })
    );
    const channelList = channelNames.map(n => '• #' + n).join('\n');
    await slack.chat.postMessage({
      channel: dm.channel.id,
      text: 'Your access to ' + channelIds.length + ' channel(s) has been removed.',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🔔 Access Update Notification' } },
        { type: 'section', text: { type: 'mrkdwn', text: 'Hi ' + userName + ',\n\nYour access to *' + channelIds.length + ' channel(s)* has been removed by a workspace admin.' } },
        { type: 'section', text: { type: 'mrkdwn', text: '*Channels removed:*\n' + channelList } },
        { type: 'section', text: { type: 'mrkdwn', text: '*Reason:* ' + reason } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'If you believe this was done in error, please contact your workspace administrator.' }] }
      ]
    });
  } catch (error) {
    console.error('[NOTIFY] Failed to notify user:', error.message);
  }
}

module.exports = { sendRevocationNotification };
