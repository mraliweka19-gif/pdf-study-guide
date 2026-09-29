<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/1cb389c6-82bb-4e99-8e68-1d20e992d4c1

## Run Locally

**Prerequisites:**  Node.js

> On Windows, avoid extracting the project into a folder name that contains `&` or other shell operators. Rename the folder to something like `pdf-study-guide-egyptian-arabic-ai-tutor` before running npm commands.

1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) (or `.env`) to your Gemini API key
3. Run the app:
   `npm run dev`
