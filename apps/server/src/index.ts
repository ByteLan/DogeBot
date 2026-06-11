import cors from 'cors';
import express from 'express';
import { authenticate, createToken, requireAuth, type AuthenticatedRequest } from './auth.js';
import { getRandomMmVideo, redirectRandomMmVideo, uploadDouyinAwemeRecords } from './douyin.js';
import { createFeishuBotForUser, deleteOwnedFeishuBot, feishuWebhook, listFeishuBots, probeFeishuBot, publicBot, startFeishuCronScheduler, stopFeishuCronScheduler } from './feishu.js';
import { feishuConnectionManager } from './feishuConnection.js';
import { beginFeishuQrRegistration, pollFeishuQrRegistration } from './feishuOnboard.js';

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/open-api/v1/mm', getRandomMmVideo);
app.get('/open-api/v1/mm/redirect', redirectRandomMmVideo);

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = typeof username === 'string' && typeof password === 'string' ? authenticate(username, password) : null;
  if (!user) {
    res.status(401).json({ error: 'invalid username or password' });
    return;
  }
  res.json({ token: createToken(user), user });
});

app.get('/api/feishu/bots', requireAuth, listFeishuBots);
app.get('/api/feishu/connections', requireAuth, (_req, res) => {
  res.json({ connections: feishuConnectionManager.snapshot() });
});
app.post('/api/douyin/aweme-records', requireAuth, uploadDouyinAwemeRecords);
app.post('/api/feishu/bots', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const result = createFeishuBotForUser(req.user.id, req.body);
  if (result.error || !result.bot) {
    res.status(result.status).json({ error: result.error || 'failed to create bot' });
    return;
  }
  void feishuConnectionManager.startBot(result.bot);
  res.status(201).json({ bot: publicBot(result.bot) });
});
app.post('/api/feishu/bots/:id/probe', requireAuth, probeFeishuBot);
app.post('/api/feishu/qr-registration/begin', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    res.json(await beginFeishuQrRegistration(req.body?.domain || 'feishu'));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'failed to begin registration' });
  }
});
app.post('/api/feishu/qr-registration/poll', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    res.json(await pollFeishuQrRegistration({
      userId: req.user.id,
      deviceCode: String(req.body?.deviceCode || ''),
      domain: req.body?.domain || 'feishu',
      interval: Number(req.body?.interval || 5)
    }));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'failed to poll registration' });
  }
});
app.delete('/api/feishu/bots/:id', requireAuth, (req: AuthenticatedRequest, res) => {
  const botId = Number(req.params.id);
  if (!req.user || !deleteOwnedFeishuBot(botId, req.user.id)) {
    res.status(404).json({ error: 'bot not found' });
    return;
  }
  feishuConnectionManager.stopBot(botId);
  res.status(204).end();
});
app.post('/feishu/webhook/:id', feishuWebhook);

app.listen(port, () => {
  console.log(`DogeBot server listening on http://127.0.0.1:${port}`);
  void feishuConnectionManager.startAll();
  startFeishuCronScheduler();
});

process.on('SIGINT', () => {
  stopFeishuCronScheduler();
  feishuConnectionManager.stopAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopFeishuCronScheduler();
  feishuConnectionManager.stopAll();
  process.exit(0);
});
