import express, { type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { explainSlide, generateQuestions, transcribeAudio } from './lib/handlers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Allow large PDF/audio payloads from the browser without 413 errors.
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// All Gemini logic lives in ./lib/handlers so the exact same code powers both
// this Express server (local dev / Cloud Run) and the Vercel serverless
// functions in ./api. Handlers return { status, data }.
app.post('/api/explain-slide', async (req: Request, res: Response) => {
  const result = await explainSlide(req.body);
  res.status(result.status).json(result.data);
});

app.post('/api/generate-questions', async (req: Request, res: Response) => {
  const result = await generateQuestions(req.body);
  res.status(result.status).json(result.data);
});

app.post('/api/transcribe-audio', async (req: Request, res: Response) => {
  const result = await transcribeAudio(req.body);
  res.status(result.status).json(result.data);
});

// Vite middleware in dev or static files in production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
