const { slack } = require('../slack/client');
const { generateAccessSnapshot } = require('../services/accessService');
const { buildAccessOverviewView } = require('../views/usersAccessView');
const { buildUserAccessModal } = require('../modals/userAccessModal');
const { buildLoadingView } = require('../views/loadingView');
const { generateCSV, generateExcelXML } = require('../services/exportService');
const { isWorkspaceAdmin } = require('../utils/authz');

async function handleAction(payload) {
  const userId = payload.user.id;
  const action = payload.actions[0].action_id;

  // Authorization (C3/M6): actions that expose or act on the whole workspace
  // require an owner/admin. (view_user_detail keeps its own inline modal check.)
  const ADMIN_ONLY = new Set(['refresh_access_data', 'export_csv', 'export_excel']);
  if (ADMIN_ONLY.has(action) && !(await isWorkspaceAdmin(userId))) {
    await slack.chat.postMessage({
      channel: userId,
      text: '🚫 *Access Denied* — only workspace Owners and Admins can use this action.'
    }).catch(() => {});
    return;
  }

  try {
    // ─── Refresh dashboard ───
    if (action === 'refresh_access_data') {
      await slack.views.publish({
        user_id: userId,
        view: buildLoadingView('Refreshing access data from Slack...')
      });
      const snapshot = await generateAccessSnapshot({ force: true });
      await slack.views.publish({
        user_id: userId,
        view: buildAccessOverviewView(snapshot)
      });
    }

    // ─── Export CSV ───
    if (action === 'export_csv') {
      // Open DM to get a valid channel_id (user IDs don't work with filesUploadV2)
      const dm = await slack.conversations.open({ users: userId });
      const dmChannelId = dm.channel.id;

      await slack.chat.postMessage({
        channel: dmChannelId,
        text: '⏳ Generating CSV export...'
      });

      const { csv, metadata } = await generateCSV();
      const timestamp = new Date().toISOString().slice(0, 10);

      await slack.filesUploadV2({
        channel_id: dmChannelId,
        file: Buffer.from(csv, 'utf-8'),
        filename: `access-review-${timestamp}.csv`,
        title: `Access Review Export - ${timestamp}`,
        initial_comment: `📥 *CSV Export Complete*\n👥 ${metadata.totalUsers} users | 📢 ${metadata.totalChannels} channels`
      });
    }

    // ─── Export Excel ───
    if (action === 'export_excel') {
      const dm = await slack.conversations.open({ users: userId });
      const dmChannelId = dm.channel.id;

      await slack.chat.postMessage({
        channel: dmChannelId,
        text: '⏳ Generating Excel export...'
      });

      const data = await generateExcelXML();
      const timestamp = new Date().toISOString().slice(0, 10);
      const xmlContent = buildExcelXml(data);

      await slack.filesUploadV2({
        channel_id: dmChannelId,
        file: Buffer.from(xmlContent, 'utf-8'),
        filename: `access-review-${timestamp}.xml`,
        title: `Access Review Export - ${timestamp}`,
        initial_comment: `📊 *Excel Export Complete*\n👥 ${data.metadata.totalUsers} users | 📢 ${data.metadata.totalChannels} channels\n_Contains 2 sheets: Users & Channels_`
      });
    }

    // ─── Open user access detail modal ───
    if (action === 'view_user_detail') {
      const targetUserId = payload.actions[0].value;

      const adminInfo = await slack.users.info({ user: userId });
      if (!adminInfo.user.is_owner && !adminInfo.user.is_admin) {
        await slack.views.open({
          trigger_id: payload.trigger_id,
          view: {
            type: 'modal',
            title: { type: 'plain_text', text: 'Access Denied' },
            close: { type: 'plain_text', text: 'Close' },
            blocks: [{
              type: 'section',
              text: { type: 'mrkdwn', text: '🚫 *Access Denied*\n\nOnly workspace Owners and Admins can view user access details and perform revocations.' }
            }]
          }
        });
        return;
      }

      const snapshot = await generateAccessSnapshot();
      const userAccess = snapshot.userAccessMap.get(targetUserId);

      if (userAccess) {
        await slack.views.open({
          trigger_id: payload.trigger_id,
          view: buildUserAccessModal(userAccess)
        });
      }
    }

    // ─── Ignore checkbox state changes ───
    if (action.startsWith('channel_checkbox_')) {
      return;
    }

  } catch (error) {
    console.error('Action error:', error.message);
    try {
      await slack.chat.postMessage({
        channel: userId,
        text: '❌ Something went wrong while processing that action. Please try again; if it keeps happening, contact your workspace admin.'
      });
    } catch (e) {
      // ignore
    }
  }
}

/**
 * Build XML Spreadsheet 2003 format (.xls)
 */
function buildExcelXml(data) {
  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function sheet(name, headers, rows) {
    let s = `<Worksheet ss:Name="${esc(name)}"><Table>`;
    s += '<Row>';
    for (const h of headers) {
      s += `<Cell ss:StyleID="header"><Data ss:Type="String">${esc(h)}</Data></Cell>`;
    }
    s += '</Row>';
    for (const row of rows) {
      s += '<Row>';
      for (const cell of row) {
        const type = typeof cell === 'number' ? 'Number' : 'String';
        s += `<Cell><Data ss:Type="${type}">${esc(cell)}</Data></Cell>`;
      }
      s += '</Row>';
    }
    s += '</Table></Worksheet>';
    return s;
  }

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
    'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Styles><Style ss:ID="header"><Font ss:Bold="1"/><Interior ss:Color="#D9E1F2" ss:Pattern="Solid"/></Style></Styles>' +
    sheet('Users', data.users.headers, data.users.rows) +
    sheet('Channels', data.channels.headers, data.channels.rows) +
    '</Workbook>';
}

module.exports = { handleAction };
