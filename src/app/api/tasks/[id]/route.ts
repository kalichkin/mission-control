import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run, queryAll } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import { UpdateTaskSchema } from '@/lib/validation';
import type { Task, UpdateTaskRequest, Agent, TaskDeliverable } from '@/lib/types';

// Normalize flat agent fields into nested assigned_agent shape for SSE broadcasts
function normalizeTask(task: Task & { assigned_agent_name?: string; assigned_agent_emoji?: string }): Task {
  return {
    ...task,
    assigned_agent: task.assigned_agent_id
      ? {
          id: task.assigned_agent_id,
          name: task.assigned_agent_name,
          avatar_emoji: task.assigned_agent_emoji,
        } as Agent
      : undefined,
  };
}

// GET /api/tasks/[id] - Get a single task
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const task = queryOne<Task>(
      `SELECT t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji
       FROM tasks t
       LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
       WHERE t.id = ?`,
      [id]
    );

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    return NextResponse.json(normalizeTask(task as Task & { assigned_agent_name?: string; assigned_agent_emoji?: string }));
  } catch (error) {
    console.error('Failed to fetch task:', error);
    return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 });
  }
}

// PATCH /api/tasks/[id] - Update a task
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body: UpdateTaskRequest & { updated_by_agent_id?: string } = await request.json();

    // Validate input with Zod
    const validation = UpdateTaskSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }

    const validatedData = validation.data;

    const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    const now = new Date().toISOString();

    // Workflow enforcement for agent-initiated approvals
    // If an agent is trying to move review→done, they must be a master agent
    // User-initiated moves (no agent ID) are allowed
    if (validatedData.status === 'done' && existing.status === 'review' && validatedData.updated_by_agent_id) {
      const updatingAgent = queryOne<Agent>(
        'SELECT is_master FROM agents WHERE id = ?',
        [validatedData.updated_by_agent_id]
      );

      if (!updatingAgent || !updatingAgent.is_master) {
        return NextResponse.json(
          { error: 'Forbidden: only the master agent can approve tasks' },
          { status: 403 }
        );
      }
    }

    if (validatedData.title !== undefined) {
      updates.push('title = ?');
      values.push(validatedData.title);
    }
    if (validatedData.description !== undefined) {
      updates.push('description = ?');
      values.push(validatedData.description);
    }
    if (validatedData.priority !== undefined) {
      updates.push('priority = ?');
      values.push(validatedData.priority);
    }
    if (validatedData.due_date !== undefined) {
      updates.push('due_date = ?');
      values.push(validatedData.due_date);
    }

    // Track if we need to dispatch task
    let shouldDispatch = false;

    // Handle status change
    if (validatedData.status !== undefined && validatedData.status !== existing.status) {
      updates.push('status = ?');
      values.push(validatedData.status);

      // Auto-dispatch when moving to assigned
      if (validatedData.status === 'assigned' && existing.assigned_agent_id) {
        shouldDispatch = true;
      }

      // Log status change event
      const eventType = validatedData.status === 'done' ? 'task_completed' : 'task_status_changed';
      run(
        `INSERT INTO events (id, type, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), eventType, id, `Task "${existing.title}" moved to ${validatedData.status}`, now]
      );
    }

    // Handle assignment change
    if (validatedData.assigned_agent_id !== undefined && validatedData.assigned_agent_id !== existing.assigned_agent_id) {
      updates.push('assigned_agent_id = ?');
      values.push(validatedData.assigned_agent_id);

      if (validatedData.assigned_agent_id) {
        const agent = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [validatedData.assigned_agent_id]);
        if (agent) {
          run(
            `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [uuidv4(), 'task_assigned', validatedData.assigned_agent_id, id, `"${existing.title}" assigned to ${agent.name}`, now]
          );

          // Auto-dispatch if already in assigned status or being assigned now
          if (existing.status === 'assigned' || validatedData.status === 'assigned') {
            shouldDispatch = true;
          }
        }
      }
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No updates provided' }, { status: 400 });
    }

    updates.push('updated_at = ?');
    values.push(now);
    values.push(id);

    run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, values);

    // Fetch updated task with all joined fields
    const task = queryOne<Task>(
      `SELECT t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji,
        ca.name as created_by_agent_name,
        ca.avatar_emoji as created_by_agent_emoji
       FROM tasks t
       LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
       LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
       WHERE t.id = ?`,
      [id]
    );

    // Broadcast task update via SSE (normalize to nested assigned_agent shape)
    if (task) {
      broadcast({
        type: 'task_updated',
        payload: normalizeTask(task as Task & { assigned_agent_name?: string; assigned_agent_emoji?: string }),
      });
    }

    // Sync agent status based on task status change
    if (validatedData.status !== undefined && validatedData.status !== existing.status) {
      const agentId = validatedData.assigned_agent_id || existing.assigned_agent_id;
      if (agentId) {
        if (validatedData.status === 'in_progress') {
          // Agent starts working
          run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', ['working', now, agentId]);
          const agentObj = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [agentId]);
          run('INSERT INTO events (id, type, agent_id, message, created_at) VALUES (?, ?, ?, ?, ?)',
            [uuidv4(), 'agent_status_changed', agentId, `${agentObj?.name || 'Agent'} is now working`, now]);
          broadcast({ type: 'agent_status_changed', payload: { agent_id: agentId, status: 'working' } });
        } else if (['done', 'review', 'inbox', 'testing'].includes(validatedData.status)) {
          // Check if agent has any OTHER in_progress tasks
          const otherActive = queryOne<{ cnt: number }>(
            'SELECT COUNT(*) as cnt FROM tasks WHERE assigned_agent_id = ? AND status = ? AND id != ?',
            [agentId, 'in_progress', id]
          );
          if (!otherActive || otherActive.cnt === 0) {
            run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', ['standby', now, agentId]);
            const agentObj = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [agentId]);
            run('INSERT INTO events (id, type, agent_id, message, created_at) VALUES (?, ?, ?, ?, ?)',
              [uuidv4(), 'agent_status_changed', agentId, `${agentObj?.name || 'Agent'} is now standby`, now]);
            broadcast({ type: 'agent_status_changed', payload: { agent_id: agentId, status: 'standby' } });
          }
        }
      }
    }

    // Trigger auto-dispatch if needed
    if (shouldDispatch) {
      // Call dispatch endpoint asynchronously (don't wait for response)
      const missionControlUrl = getMissionControlUrl();
      const mcApiToken = process.env.MC_API_TOKEN;
      const dispatchHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (mcApiToken) {
        dispatchHeaders['Authorization'] = `Bearer ${mcApiToken}`;
      }
      fetch(`${missionControlUrl}/api/tasks/${id}/dispatch`, {
        method: 'POST',
        headers: dispatchHeaders
      }).catch(err => {
        console.error('Auto-dispatch failed:', err);
      });
    }

    return NextResponse.json(normalizeTask(task as Task & { assigned_agent_name?: string; assigned_agent_emoji?: string }));
  } catch (error) {
    console.error('Failed to update task:', error);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

// DELETE /api/tasks/[id] - Delete a task
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);

    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Delete or nullify related records first (foreign key constraints)
    // Note: task_activities and task_deliverables have ON DELETE CASCADE
    run('DELETE FROM openclaw_sessions WHERE task_id = ?', [id]);
    run('DELETE FROM events WHERE task_id = ?', [id]);
    // Conversations reference tasks - nullify or delete
    run('UPDATE conversations SET task_id = NULL WHERE task_id = ?', [id]);

    // Now delete the task (cascades to task_activities and task_deliverables)
    run('DELETE FROM tasks WHERE id = ?', [id]);

    // Broadcast deletion via SSE
    broadcast({
      type: 'task_deleted',
      payload: { id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete task:', error);
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}
