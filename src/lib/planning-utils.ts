import { getOpenClawClient } from './openclaw/client';

// Maximum input length for extractJSON to prevent ReDoS attacks
const MAX_EXTRACT_JSON_LENGTH = 1_000_000; // 1MB

/**
 * Extract JSON from a response that might have markdown code blocks or surrounding text.
 * Handles various formats:
 * - Direct JSON
 * - Markdown code blocks (```json ... ``` or ``` ... ```)
 * - JSON embedded in text (first { to last })
 */
export function extractJSON(text: string): object | null {
  // Security: Prevent ReDoS on massive inputs
  if (text.length > MAX_EXTRACT_JSON_LENGTH) {
    console.warn('[Planning Utils] Input exceeds maximum length for JSON extraction:', text.length);
    return null;
  }

  // First, try direct parse
  try {
    return JSON.parse(text.trim());
  } catch {
    // Continue to other methods
  }

  // Try to extract from markdown code block (```json ... ``` or ``` ... ```)
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // Continue
    }
  }

  // Try to find JSON object in the text (first { to last })
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      // Continue
    }
  }

  return null;
}

/**
 * Get messages from OpenClaw API for a given session.
 * Uses two strategies: first tries direct JSONL file read (fast, reliable),
 * falls back to WebSocket chat.history API.
 * Returns assistant messages with text content extracted.
 */
export async function getMessagesFromOpenClaw(
  sessionKey: string,
  transcriptPath?: string | null
): Promise<Array<{ role: string; content: string }>> {
  // Strategy 1: Read directly from JSONL transcript file (stored path or auto-discovered)
  try {
    const fs = await import('fs');
    
    // Use provided transcript path if available
    let filePath = transcriptPath || null;
    
    // If no stored path, try to find it
    if (!filePath) {
      const path = await import('path');
      const sessionsDir = path.join(process.env.HOME || '/root', '.openclaw', 'agents', 'main', 'sessions');
      
      if (fs.existsSync(sessionsDir)) {
        const files = fs.readdirSync(sessionsDir)
          .filter((f: string) => f.endsWith('.jsonl'))
          .map((f: string) => ({
            path: path.join(sessionsDir, f),
            mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs
          }))
          .sort((a: any, b: any) => b.mtime - a.mtime)
          .slice(0, 10);
        
        for (const file of files) {
          try {
            const content = fs.readFileSync(file.path, {encoding: 'utf-8'}) as string;
            const lines = content.split('\n').filter((l: string) => l.trim());
            for (let i = 0; i < Math.min(lines.length, 5); i++) {
              const data = JSON.parse(lines[i]);
              if (data.type === 'message' && data.message?.role === 'user') {
                const txt = typeof data.message.content === 'string' ? data.message.content : '';
                if (txt.startsWith('You are a planning orchestrator')) {
                  filePath = file.path;
                  break;
                }
              }
            }
            if (filePath) break;
          } catch {}
        }
      }
    }

    if (filePath && fs.existsSync(filePath)) {
      console.log('[Planning Utils] Reading transcript from file:', filePath);
      const content = fs.readFileSync(filePath, { encoding: 'utf-8' }) as string;
      const lines = content.split('\n').filter((l: string) => l.trim());
      const messages: Array<{ role: string; content: string }> = [];

      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.type === 'message' && data.message?.role === 'assistant') {
            const msg = data.message;
            let text = '';
            
            if (typeof msg.content === 'string') {
              text = msg.content;
            } else if (Array.isArray(msg.content)) {
              const textContent = msg.content.find((c: any) => c.type === 'text');
              if (textContent?.text) {
                text = textContent.text;
              }
            }

            if (text) {
              messages.push({ role: 'assistant', content: text });
            }
          }
        } catch {}
      }

      console.log('[Planning Utils] File read: found', messages.length, 'assistant messages');
      if (messages.length > 0) return messages;
    } else {
      console.log('[Planning Utils] No transcript path found for session:', sessionKey);
    }
  } catch (fileErr) {
    console.log('[Planning Utils] File-based read failed, falling back to chat.history:', (fileErr as Error).message);
  }

  // Strategy 2: Fall back to WebSocket chat.history API
  try {
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }

    // Use chat.history API to get session messages
    const result = await client.call<{
      messages: Array<{
        role: string;
        content: Array<{ type: string; text?: string }> | string;
      }>;
    }>('chat.history', {
      sessionKey,
      limit: 50,
    });

    const messages: Array<{ role: string; content: string }> = [];

    console.log('[Planning Utils] chat.history returned', result.messages?.length || 0, 'messages for session', sessionKey);

    for (const msg of result.messages || []) {
      if (msg.role === 'assistant') {
        let text = '';
        
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textContent = msg.content.find((c: any) => c.type === 'text');
          if (textContent?.text) {
            text = textContent.text;
          }
        }

        if (text) {
          messages.push({ role: 'assistant', content: text });
          console.log('[Planning Utils] Found assistant message, length:', text.length, 'preview:', text.substring(0, 80));
        }
      }
    }

    console.log('[Planning Utils] WebSocket: extracted', messages.length, 'assistant messages');
    return messages;
  } catch (err) {
    console.error('[Planning Utils] Failed to get messages from OpenClaw:', err);
    return [];
  }
}
