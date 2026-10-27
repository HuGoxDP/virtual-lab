// backend/lti/deeplink.js
//
// The Deep Linking response: the claims of the signed LtiDeepLinkingResponse JWT for one picked scenario, and the
// self-submitting page that carries it back to the platform's return URL. Knows nothing about Express.

const crypto = require('node:crypto');

const { SCORE_MAXIMUM } = require('./grades');

const CLAIM = 'https://purl.imsglobal.org/spec/lti/claim/';
const DL_CLAIM = 'https://purl.imsglobal.org/spec/lti-dl/claim/';

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/**
 * Claims of the response. `iss` is our client_id and `aud` the platform, as the spec requires of a tool's
 * message; `data` is echoed unchanged from the request when it carried one.
 *
 * The content item targets the scenario (catalog id), never an archive hash: a later upload is picked up
 * by activities that already exist. `lineItem` asks the platform for a gradebook column of 100 points.
 */
function buildDeepLinkClaims({ session, scenario, launchUrl }) {
  const claims = {
    iss: session.clientId,
    aud: session.issuer,
    nonce: crypto.randomUUID(),
    [`${CLAIM}message_type`]: 'LtiDeepLinkingResponse',
    [`${CLAIM}version`]: '1.3.0',
    [`${CLAIM}deployment_id`]: session.deploymentId,
    [`${DL_CLAIM}content_items`]: [{
      type: 'ltiResourceLink',
      title: scenario.title,
      url: launchUrl,
      custom: { scenario_id: scenario.id },
      lineItem: { scoreMaximum: SCORE_MAXIMUM, label: scenario.title, resourceId: scenario.id },
    }],
  };
  if (session.deepLinkData) claims[`${DL_CLAIM}data`] = session.deepLinkData;
  return claims;
}

/** The auto-submit page. Its script is nonce'd; the caller's CSP must allow that nonce and the form target. */
function deepLinkPage({ returnUrl, jwt, nonce }) {
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>Повернення до LMS</title></head>
<body>
<form method="post" action="${escapeHtml(returnUrl)}">
<input type="hidden" name="JWT" value="${escapeHtml(jwt)}">
<noscript><button type="submit">Повернутися до LMS</button></noscript>
</form>
<script nonce="${nonce}">document.forms[0].submit();</script>
</body></html>`;
}

module.exports = { buildDeepLinkClaims, deepLinkPage };
