import { generateQuestions } from '../lib/handlers';

// Per-function Vercel config (avoids a fragile `functions` glob in vercel.json).
export const config = { maxDuration: 300, memory: 1024 };

type Req = { method?: string; body?: any };
type Res = {
  status: (code: number) => Res;
  json: (data: any) => any;
  setHeader: (name: string, value: string) => void;
};

export default async function handler(req: Req, res: Res) {
  if (req.method && req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const result = await generateQuestions(body);
  return res.status(result.status).json(result.data);
}
