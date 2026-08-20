import { runProcess } from './runProcess.js';

export function derivePaneSlug(value: string, fallback = 'pane'): string {
  const segment = value.split('/').pop() || value;
  const normalized = segment
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}

export const callClaudeCode = async (prompt: string): Promise<string | null> => {
  try {
    const result = await runProcess('claude', {
      args: ['--no-interactive', '--max-turns', '1'],
      input: prompt,
      timeoutMs: 5000,
    });
    const lines = result.stdout.trim().split('\n').slice(0, 5);
    const response = lines.join(' ').trim();
    return response || null;
  } catch {
    return null;
  }
};

export const generateSlug = async (prompt: string): Promise<string> => {
  if (!prompt) return `psyche-${Date.now()}`;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey) {
    // Try multiple models with fallback
    const models = ['google/gemini-2.5-flash', 'x-ai/grok-4-fast:free', 'openai/gpt-4o-mini'];

    for (const model of models) {
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'user',
                content: `Generate a 1-2 word kebab-case slug for this prompt. Only respond with the slug, nothing else: "${prompt}"`
              }
            ],
            max_tokens: 10,
            temperature: 0.3
          })
        });

        if (response.ok) {
          const data = await response.json() as any;
          const slug = data.choices[0].message.content.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
          if (slug) return slug;
        }
      } catch {
        // Try next model
        continue;
      }
    }
  }

  const claudeResponse = await callClaudeCode(
    `Generate a 1-2 word kebab-case slug for this prompt. Only respond with the slug, nothing else: "${prompt}"`
  );
  if (claudeResponse) {
    const slug = claudeResponse.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (slug) return slug;
  }

  return `psyche-${Date.now()}`;
};
