const { slack, invalidateTeamClient } = require('../slack/client');
const { generateAccessSnapshot } = require('../services/accessService');
const { buildLoadingView } = require('../views/loadingView');
const { buildAccessOverviewView } = require('../views/usersAccessView');
const { isWorkspaceAdmin } = require('../utils/authz');
const { listCampaigns } = require('../services/campaignService');
const { getWorkspacePlan } = require('../services/planService');

function homeMessage(text) {
  return { type: 'home', blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

async function handleEvent(event) {
  // Public-distribution lifecycle: when a workspace removes the app (or its
  // tokens are revoked), delete its stored token — and on full uninstall,
  // wipe that workspace's campaigns + audit entries too (we keep no data for
  // workspaces that removed the app).
  const lifecycleType = event.event?.type;
  if (lifecycleType === 'app_uninstalled' || lifecycleType === 'tokens_revoked') {
    const teamId = event.team_id;
    if (teamId) {
      const { deleteInstallation } = require('../services/installationService');
      invalidateTeamClient(teamId);
      await deleteInstallation(teamId, { wipeData: lifecycleType === 'app_uninstalled' })
        .catch(e => console.error('[LIFECYCLE] cleanup failed for', teamId, e.message));
      console.log('[LIFECYCLE]', lifecycleType, '— installation removed for team', teamId);
    }
    return;
  }

  if (event.event?.type === 'app_home_opened') {
    const userId = event.event.user;
    try {
      // M6: only owners/admins may view the workspace-wide access dashboard.
      if (!(await isWorkspaceAdmin(userId))) {
        await slack.views.publish({
          user_id: userId,
          view: homeMessage('🔒 *Access Review*\n\nOnly workspace Owners and Admins can view the access dashboard. If you need access, please contact a workspace admin.')
        });
        return;
      }

      await slack.views.publish({
        user_id: userId,
        view: buildLoadingView('Fetching access data from Slack...')
      });
      const snapshot = await generateAccessSnapshot();
      const campaigns = await listCampaigns({ activeOnly: true }).catch(() => []);
      const plan = await getWorkspacePlan().catch(() => ({}));
      await slack.views.publish({
        user_id: userId,
        view: buildAccessOverviewView(snapshot, 'riskScore', campaigns, { plan })
      });
    } catch (error) {
      console.error('Home load error:', error.message);
      // M7: surface a clear error state with a retry instead of a stuck spinner.
      try {
        await slack.views.publish({
          user_id: userId,
          view: {
            type: 'home',
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: '⚠️ *Could not load access data.*\nSlack may be slow or temporarily unavailable. Please try again.' } },
              { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '🔄 Retry' }, action_id: 'refresh_access_data', style: 'primary' }] }
            ]
          }
        });
      } catch (e) {
        console.error('Home error-view publish failed:', e.message);
      }
    }
  }
}

module.exports = { handleEvent };
