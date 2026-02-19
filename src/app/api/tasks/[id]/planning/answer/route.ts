import { NextRequest, NextResponse } from 'next/server';
import { getDb, queryOne, run } from '@/lib/db';
import { extractJSON } from '@/lib/planning-utils';
import { callPlanningLLM, getPlanningSessionKey } from '@/lib/planning-llm';
import { broadcast } from '@/lib/events';
import { Task } from '@/lib/types';

// POST /api/tasks/[id]/planning/answer - Submit an answer and get next question
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const body = await request.json();
    const { answer, otherText } = body;

    if (!answer) {
      return NextResponse.json({ error: 'Answer is required' }, { status: 400 });
    }

    // Get task
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
      workspace_id: string;
      planning_session_key?: string;
      planning_messages?: string;
      planning_complete?: number;
    } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (!task.planning_session_key) {
      return NextResponse.json({ error: 'Planning not started' }, { status: 400 });
    }

    if (task.planning_complete) {
      return NextResponse.json({ error: 'Planning already complete' }, { status: 400 });
    }

    // Build the answer message
    const answerText = answer === 'other' && otherText 
      ? `Other: ${otherText}`
      : answer;

    // Parse existing messages and build conversation for LLM
    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    
    // Add user answer
    const answerPrompt = `User's answer: ${answerText}

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

    messages.push({ role: 'user', content: answerPrompt, timestamp: Date.now() });

    console.log('[Planning Answer] Sending answer to scout agent for task:', taskId);

    // Send to scout agent and wait for response
    const response = await callPlanningLLM(taskId, answerPrompt);

    // Add assistant response to messages
    messages.push({ role: 'assistant', content: response, timestamp: Date.now() });

    // Parse the response
    const parsed = extractJSON(response) as {
      status?: string;
      question?: string;
      options?: Array<{ id: string; label: string }>;
      spec?: object;
      agents?: Array<{
        name: string;
        role: string;
        avatar_emoji?: string;
        soul_md?: string;
        instructions?: string;
      }>;
      execution_plan?: object;
    } | null;

    console.log('[Planning Answer] Parsed response:', {
      hasStatus: !!parsed?.status,
      hasQuestion: !!parsed?.question,
      status: parsed?.status,
    });

    // Check if planning is complete
    if (parsed && parsed.status === 'complete') {
      console.log('[Planning Answer] Planning complete, handling completion...');
      const { firstAgentId, dispatchError } = await handlePlanningCompletion(taskId, parsed, messages);

      return NextResponse.json({
        success: true,
        complete: true,
        spec: parsed.spec,
        agents: parsed.agents,
        executionPlan: parsed.execution_plan,
        messages,
        autoDispatched: !!firstAgentId,
        dispatchError,
      });
    }

    // Extract current question
    let currentQuestion = null;
    if (parsed && parsed.question && parsed.options) {
      currentQuestion = parsed;
    }

    // Update messages in DB
    getDb().prepare(`
      UPDATE tasks SET planning_messages = ? WHERE id = ?
    `).run(JSON.stringify(messages), taskId);

    return NextResponse.json({
      success: true,
      complete: false,
      messages,
      currentQuestion,
    });
  } catch (error) {
    console.error('Failed to submit answer:', error);
    return NextResponse.json({ error: 'Failed to submit answer: ' + (error as Error).message }, { status: 500 });
  }
}

// Handle planning completion (same logic as was in poll/route.ts)
async function handlePlanningCompletion(taskId: string, parsed: any, messages: any[]) {
  const db = getDb();
  const dispatchError: string | null = null;
  const firstAgentId: string | null = null;

  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET planning_messages = ?,
          planning_spec = ?,
          planning_agents = ?,
          status = 'planning',
          planning_dispatch_error = NULL
      WHERE id = ?
    `).run(
      JSON.stringify(messages),
      JSON.stringify(parsed.spec),
      JSON.stringify(parsed.agents),
      taskId
    );

    // NOTE: We intentionally do NOT create real agent records from planning suggestions.
    // Planning-suggested agents are stored in planning_agents JSON for reference only.
    // Real dispatch should be done by assigning the task to an existing registered agent.
    // Creating ghost agents pollutes the agent dropdown and dispatching to them fails
    // (no openclaw_agent_id → messages go nowhere).

    return null; // No auto-dispatch to planning-suggested agents
  });

  transaction();

  // Planning complete — move task to inbox for manual agent assignment.
  // No auto-dispatch: the user/orchestrator assigns to a real registered agent.
  db.prepare(`
    UPDATE tasks SET planning_complete = 1, status = 'inbox', planning_dispatch_error = NULL, updated_at = datetime('now') WHERE id = ?
  `).run(taskId);

  // Broadcast
  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask });
  }

  return { firstAgentId: null, parsed, dispatchError: null };
}
