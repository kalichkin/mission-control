import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { extractJSON } from '@/lib/planning-utils';

/**
 * GET /api/tasks/[id]/planning/poll - Check planning state
 * 
 * With direct LLM calls, polling is mostly for catching up on state.
 * The answer endpoint now returns responses synchronously.
 * This endpoint is kept for backwards compatibility with the frontend.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const task = queryOne<{
      id: string;
      planning_session_key?: string;
      planning_messages?: string;
      planning_complete?: number;
      planning_dispatch_error?: string;
      planning_spec?: string;
      planning_agents?: string;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task || !task.planning_session_key) {
      return NextResponse.json({ error: 'Planning session not found' }, { status: 404 });
    }

    if (task.planning_complete) {
      return NextResponse.json({
        hasUpdates: true,
        isComplete: true,
        complete: true,
        spec: task.planning_spec ? JSON.parse(task.planning_spec) : null,
        agents: task.planning_agents ? JSON.parse(task.planning_agents) : null,
      });
    }

    if (task.planning_dispatch_error) {
      return NextResponse.json({
        hasUpdates: true,
        dispatchError: task.planning_dispatch_error,
      });
    }

    // Return current messages and question state
    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    
    // Find the latest question from assistant messages
    const lastAssistantMessage = [...messages].reverse().find((m: { role: string }) => m.role === 'assistant');
    let currentQuestion = null;

    if (lastAssistantMessage) {
      const parsed = extractJSON(lastAssistantMessage.content);
      if (parsed && 'question' in parsed) {
        currentQuestion = parsed;
      }
    }

    return NextResponse.json({
      hasUpdates: messages.length > 0,
      isComplete: false,
      messages,
      currentQuestion,
    });
  } catch (error) {
    console.error('Failed to poll planning state:', error);
    return NextResponse.json({ error: 'Failed to poll planning state' }, { status: 500 });
  }
}
