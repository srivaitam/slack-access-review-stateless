function buildLoadingView(message = 'Loading access data...') {
  return {
    type: 'home',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🔐 Slack Access Review' }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⏳ *${message}*\n\nThis may take a few moments depending on workspace size.`
        }
      }
    ]
  };
}

module.exports = { buildLoadingView };
