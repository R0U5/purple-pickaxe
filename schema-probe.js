// Schema probe - paste this entire block into the Twitch console (F12 > Console)
// while on a channel page. It tests GQL field names against the live API.

(async function probeSchema() {
  const TWITCH_GQL = 'https://gql.twitch.tv/gql';
  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

  // Get auth token from cookies
  const authToken = document.cookie.match(/(?:^|;\s*)auth-token=([^;]*)/)?.[1] || '';
  if (!authToken) { console.error('PROBE: No auth-token cookie found!'); return; }

  const channel = window.location.pathname.split('/')[1];
  console.log('PROBE: Channel =', channel);

  async function gql(query, variables = {}) {
    const res = await fetch(TWITCH_GQL, {
      method: 'POST',
      headers: {
        'Client-Id': CLIENT_ID,
        'Content-Type': 'application/json',
        'Authorization': `OAuth ${authToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    return res.json();
  }

  // Step 1: Resolve channel ID
  const userR = await gql('query($login: String!) { user(login: $login) { id } }', { login: channel });
  const channelId = userR?.data?.user?.id;
  console.log('PROBE: Channel ID =', channelId);
  if (!channelId) { console.error('PROBE: Could not resolve channel ID'); return; }

  const results = {};

  // Step 2: Probe channel points field names
  console.log('\n=== CHANNEL POINTS PROBES ===');

  const cpQueries = [
    { name: 'channel.channelPoints', q: 'query($id: ID!) { channel(id: $id) { id channelPoints { balance } } }' },
    { name: 'channel.communityPoints', q: 'query($id: ID!) { channel(id: $id) { id communityPoints { balance } } }' },
    { name: 'channel.self.communityPoints', q: 'query($id: ID!) { channel(id: $id) { id self { communityPoints { balance } } } }' },
    { name: 'channel.self.channelPoints', q: 'query($id: ID!) { channel(id: $id) { id self { channelPoints { balance } } } }' },
    { name: 'communityPoints(channelID:)', q: 'query($id: ID!) { communityPoints(channelID: $id) { balance } }' },
    { name: 'user.communityPoints', q: 'query($login: String!) { user(login: $login) { id communityPoints { balance } } }' },
    { name: 'user.channelPoints', q: 'query($login: String!) { user(login: $login) { id channelPoints { balance } } }' },
    { name: 'stream.communityPoints', q: 'query($login: String!) { user(login: $login) { stream { communityPoints { balance } } } }' },
  ];

  for (const { name, q } of cpQueries) {
    const v = name.includes('$login') ? { login: channel } : { id: channelId };
    const r = await gql(q, v);
    results[name] = r.errors ? 'FAIL: ' + r.errors.map(e => e.message).join('; ') : 'OK: ' + JSON.stringify(r.data).slice(0, 200);
    console.log(`  ${name}:`, results[name]);
  }

  // Step 3: Probe drop campaign sub-fields
  console.log('\n=== DROP CAMPAIGN PROBES ===');

  const dropQueries = [
    { name: 'timeBasedDrops (basic)', q: 'query { currentUser { dropCampaigns { id timeBasedDrops { id name } } } }' },
    { name: 'timeBasedDrops (with self)', q: 'query { currentUser { dropCampaigns { id timeBasedDrops { id name self { currentMinutesWatched isClaimed } benefitEdges { benefit { name } } } } } }' },
    { name: 'drops', q: 'query { currentUser { dropCampaigns { id drops { id name } } } }' },
    { name: 'dropInstances', q: 'query { currentUser { dropCampaigns { id dropInstances { id name } } } }' },
  ];

  for (const { name, q } of dropQueries) {
    const r = await gql(q);
    results[name] = r.errors ? 'FAIL: ' + r.errors.map(e => e.message).join('; ') : 'OK: ' + JSON.stringify(r.data).slice(0, 300);
    console.log(`  ${name}:`, results[name]);
  }

  // Step 4: Probe ClaimCommunityPoints mutation
  console.log('\n=== CLAIM MUTATION PROBE ===');
  const claimR = await gql(
    'mutation($input: ClaimCommunityPointsInput!) { claimCommunityPoints(input: $input) { __typename } }',
    { input: { channelID: channelId, claimID: 'test' } }
  );
  results['ClaimCommunityPoints'] = claimR.errors ? 'FAIL: ' + claimR.errors.map(e => e.message).join('; ') : 'OK (mutation accepted structure)';
  console.log('  ClaimCommunityPoints:', results['ClaimCommunityPoints']);

  console.log('\n=== SUMMARY ===');
  for (const [k, v] of Object.entries(results)) {
    const icon = v.startsWith('OK') ? '✅' : '❌';
    console.log(`${icon} ${k}: ${v}`);
  }
  console.log('\nCopy the SUMMARY lines and send them to Goblin.');
})();
