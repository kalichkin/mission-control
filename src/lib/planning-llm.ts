/**
 * Planning LLM client.
 * 
 * Routes planning conversations through OpenClaw's scout agent instead of the main agent.
 * This avoids the session routing issue where planning prompts pollute the main agent session.
 * 
 * Uses chat.send with session key 'agent:scout:planning:<taskId>' to route to scout (Sonnet).
 * Then reads responses via getMessagesFromOpenClaw utility.
 */

import { getOpenClawClient } from './openclaw/client';
import { extractJSON } from './planning-utils';

// Use scout agent for planning (lightweight Sonnet, won't pollute main session)
const PLANNING_AGENT = process.env.PLANNING_AGENT || 'scout';
const PLANNING_SESSION_PREFIX = `agent:${PLANNING_AGENT}:planning:`;

// Max time to wait for LLM response (ms)
const RESPONSE_TIMEOUT_MS = parseInt(process.env.PLANNING_RESPONSE_TIMEOUT_MS || '45000', 10);
const POLL_INTERVAL_MS = 2000;

/**
 * Get the planning session key for a task.
 */
export function getPlanningSessionKey(taskId: string): string {
  return `${PLANNING_SESSION_PREFIX}${taskId}`;
}

/**
 * Send a message to the planning session and wait for the assistant response.
 * Routes through OpenClaw's scout agent to avoid polluting the main session.
 */
export async function callPlanningLLM(taskId: string, message: string): Promise<string> {
  const client = getOpenClawClient();
  if (!client.isConnected()) {
    await client.connect();
  }

  const sessionKey = getPlanningSessionKey(taskId);
  
  console.log('[Planning LLM] Sending to session:', sessionKey);

  // Send message to scout agent's planning session
  await client.call('chat.send', {
    sessionKey,
    message,
    idempotencyKey: `planning-${taskId}-${Date.now()}`,
  });

  // Wait for assistant response by polling the session's JSONL file
  const startTime = Date.now();
  const agentDir = process.env.HOME || '/root';
  const fs = await import('fs');
  const path = await import('path');
  
  // Count existing assistant messages before our send
  const sessionsDir = path.join(agentDir, '.openclaw', 'agents', PLANNING_AGENT, 'sessions');
  
  while (Date.now() - startTime < RESPONSE_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    
    try {
      // Try to find the session's JSONL file
      const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');
      if (!fs.existsSync(sessionsJsonPath)) continue;
      
      const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'));
      const sessionInfo = sessionsData[sessionKey];
      if (!sessionInfo?.sessionId) continue;
      
      const jsonlPath = path.join(sessionsDir, `${sessionInfo.sessionId}.jsonl`);
      if (!fs.existsSync(jsonlPath)) continue;
      
      const content = fs.readFileSync(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter((l: string) => l.trim());
      
      // Find the last assistant message
      let lastAssistantText = '';
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.type === 'message' && data.message?.role === 'assistant') {
            const msg = data.message;
            if (typeof msg.content === 'string') {
              lastAssistantText = msg.content;
            } else if (Array.isArray(msg.content)) {
              const textContent = msg.content.find((c: any) => c.type === 'text');
              if (textContent?.text) {
                lastAssistantText = textContent.text;
              }
            }
          }
        } catch {}
      }
      
      // Count user messages to know how many responses we should have
      let userCount = 0;
      let assistantCount = 0;
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.type === 'message') {
            if (data.message?.role === 'user') userCount++;
            if (data.message?.role === 'assistant') assistantCount++;
          }
        } catch {}
      }
      
      // We expect assistantCount == userCount (each user message gets a response)
      if (assistantCount >= userCount && lastAssistantText) {
        console.log('[Planning LLM] Got response, length:', lastAssistantText.length);
        return lastAssistantText;
      }
    } catch (err) {
      console.log('[Planning LLM] Poll error:', (err as Error).message);
    }
  }
  
  throw new Error(`Planning LLM timeout after ${RESPONSE_TIMEOUT_MS}ms`);
}

/**
 * Build the initial planning prompt for a task.
 */
export function buildPlanningPrompt(taskTitle: string, taskDescription: string): string {
  return `You are a planning orchestrator for Mission Control. Your job is to ask 3-5 multiple-choice questions to understand what the user needs, then produce a task spec.

TASK: ${taskTitle}
DESCRIPTION: ${taskDescription || 'No description provided'}

## PROTOCOL

1. Ask 3-5 questions to clarify scope, deliverables, audience, constraints, and priority
2. Each question MUST be multiple choice with an "Other" option
3. Questions should be specific to THIS task, not generic
4. After enough info, produce a completion spec

## RESPONSE FORMAT

You MUST respond with ONLY valid JSON. No markdown, no explanation, no code blocks. Just raw JSON.

For a question:
{"question":"Your question here?","options":[{"id":"a","label":"First option"},{"id":"b","label":"Second option"},{"id":"c","label":"Third option"},{"id":"other","label":"Other"}]}

For completion (when you have enough info after 3-5 questions):
{"status":"complete","spec":{"title":"Task title","summary":"What needs to be done","deliverables":["Deliverable 1","Deliverable 2"],"success_criteria":["How we know it is done"],"constraints":{}},"agents":[{"name":"Agent Name","role":"What they do","avatar_emoji":"emoji","soul_md":"Agent personality","instructions":"Specific instructions"}],"execution_plan":{"approach":"How to execute","steps":["Step 1","Step 2"]}}

IMPORTANT: Output ONLY the JSON object. No text before or after it. Start your response with { and end with }.

Now generate your FIRST question for this task.`;
}

/**
 * Build the answer follow-up prompt.
 */
export function buildAnswerPrompt(
  taskTitle: string, 
  taskDescription: string, 
  questionNumber: number, 
  answer: string
): string {
  return `User's answer: ${answer}

Based on this answer and the conversation so far, either ask your next question or complete the planning.

RULES:
- Respond with ONLY valid JSON. No markdown, no explanation, no code blocks.
- Start your response with { and end with }
- If you need more info, ask another multiple-choice question
- If you have enough info (after 3-5 questions total), produce the completion spec
- Always include an "other" option in questions

For a question:
{"question":"Your next question?","options":[{"id":"a","label":"Option A"},{"id":"b","label":"Option B"},{"id":"other","label":"Other"}]}

For completion:
{"status":"complete","spec":{"title":"Task title","summary":"What needs to be done","deliverables":["Deliverable 1"],"success_criteria":["How we know it is done"],"constraints":{}},"agents":[{"name":"Agent Name","role":"Role","avatar_emoji":"emoji","soul_md":"Personality","instructions":"Instructions"}],"execution_plan":{"approach":"How to execute","steps":["Step 1","Step 2"]}}`;
}
