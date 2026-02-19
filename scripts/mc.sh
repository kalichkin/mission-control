#!/usr/bin/env bash
# Mission Control CLI wrapper
# Usage:
#   mc.sh create-task "Title" "Description" <agent_name> [priority]
#   mc.sh register-subagent <task_id> <session_id> <agent_name>
#   mc.sh log-activity <task_id> <type> "message"
#   mc.sh log-deliverable <task_id> <type> "title" [path]
#   mc.sh complete-session <session_id>
#   mc.sh update-status <task_id> <status>
#   mc.sh list-tasks [status]
#   mc.sh list-agents

set -euo pipefail

MC_URL="${MISSION_CONTROL_URL:-http://localhost:4000}"
MC_TOKEN="${MISSION_CONTROL_TOKEN:-YOUR_MC_API_TOKEN_HERE}"
MC_WORKSPACE="${MISSION_CONTROL_WORKSPACE:-YOUR_WORKSPACE_ID_HERE}"

auth_header="Authorization: Bearer $MC_TOKEN"
content_type="Content-Type: application/json"

cmd="${1:-help}"
shift || true

case "$cmd" in
  create-task)
    title="${1:?Usage: mc.sh create-task TITLE DESCRIPTION AGENT_NAME [PRIORITY]}"
    description="${2:-}"
    agent_name="${3:-}"
    priority="${4:-normal}"

    # Resolve agent ID by name
    agent_id=""
    if [[ -n "$agent_name" ]]; then
      agent_id=$(curl -s "$MC_URL/api/agents" -H "$auth_header" | \
        python3 -c "import json,sys; agents=json.load(sys.stdin); matches=[a['id'] for a in agents if a['name'].lower()=='${agent_name}'.lower()]; print(matches[0] if matches else '')")
    fi

    payload=$(python3 -c "
import json
d = {
    'title': '''$title''',
    'description': '''$description''',
    'priority': '$priority',
    'status': 'inbox',
    'workspace_id': '$MC_WORKSPACE'
}
if '''$agent_id''':
    d['assigned_agent_id'] = '''$agent_id'''
    d['status'] = 'assigned'
print(json.dumps(d))
")

    result=$(curl -s -X POST "$MC_URL/api/tasks" \
      -H "$auth_header" -H "$content_type" \
      -d "$payload")
    echo "$result" | python3 -m json.tool 2>/dev/null || echo "$result"
    ;;

  register-subagent)
    task_id="${1:?Usage: mc.sh register-subagent TASK_ID SESSION_ID AGENT_NAME}"
    session_id="${2:?}"
    agent_name="${3:?}"
    curl -s -X POST "$MC_URL/api/tasks/$task_id/subagent" \
      -H "$auth_header" -H "$content_type" \
      -d "{\"openclaw_session_id\": \"$session_id\", \"agent_name\": \"$agent_name\"}"
    ;;

  log-activity)
    task_id="${1:?Usage: mc.sh log-activity TASK_ID TYPE MESSAGE}"
    activity_type="${2:?}" # spawned|updated|completed|file_created|status_changed
    message="${3:?}"
    curl -s -X POST "$MC_URL/api/tasks/$task_id/activities" \
      -H "$auth_header" -H "$content_type" \
      -d "{\"activity_type\": \"$activity_type\", \"message\": \"$message\"}"
    ;;

  log-deliverable)
    task_id="${1:?Usage: mc.sh log-deliverable TASK_ID TYPE TITLE [PATH]}"
    deliverable_type="${2:?}" # file|url|artifact
    title="${3:?}"
    path="${4:-}"
    payload="{\"deliverable_type\": \"$deliverable_type\", \"title\": \"$title\""
    [[ -n "$path" ]] && payload="$payload, \"path\": \"$path\""
    payload="$payload}"
    curl -s -X POST "$MC_URL/api/tasks/$task_id/deliverables" \
      -H "$auth_header" -H "$content_type" \
      -d "$payload"
    ;;

  complete-session)
    session_id="${1:?Usage: mc.sh complete-session SESSION_ID}"
    # Session IDs with colons break Next.js URL routing, so update DB directly
    sqlite3 /opt/mission-control/mission-control.db \
      "UPDATE openclaw_sessions SET status = 'completed', ended_at = '$(date -u +%Y-%m-%dT%H:%M:%SZ)', updated_at = '$(date -u +%Y-%m-%dT%H:%M:%SZ)' WHERE openclaw_session_id = '$session_id';"
    # Also update agent status to standby
    sqlite3 /opt/mission-control/mission-control.db \
      "UPDATE agents SET status = 'standby', updated_at = '$(date -u +%Y-%m-%dT%H:%M:%SZ)' WHERE id = (SELECT agent_id FROM openclaw_sessions WHERE openclaw_session_id = '$session_id');"
    echo "{\"status\": \"completed\", \"session\": \"$session_id\"}"
    ;;

  update-status)
    task_id_input="${1:?Usage: mc.sh update-status TASK_ID STATUS}"
    status="${2:?}" # planning|inbox|assigned|in_progress|testing|review|done
    # Resolve short ID to full UUID if needed
    if [[ ${#task_id_input} -lt 36 ]]; then
      task_id=$(curl -s "$MC_URL/api/tasks" -H "$auth_header" | \
        python3 -c "import json,sys; tasks=json.load(sys.stdin); matches=[t['id'] for t in tasks if t['id'].startswith('${task_id_input}')]; print(matches[0] if matches else '${task_id_input}')")
    else
      task_id="$task_id_input"
    fi
    result=$(curl -s -X PATCH "$MC_URL/api/tasks/$task_id" \
      -H "$auth_header" -H "$content_type" \
      -d "{\"status\": \"$status\"}")
    echo "$result"

    # Auto-sync agent status based on task status
    agent_id=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('assigned_agent_id',''))" 2>/dev/null || echo "")
    if [[ -n "$agent_id" ]]; then
      case "$status" in
        in_progress)
          curl -s -X PATCH "$MC_URL/api/agents/$agent_id" \
            -H "$auth_header" -H "$content_type" \
            -d '{"status": "working"}' > /dev/null 2>&1
          ;;
        done|review)
          # Only set to standby if agent has no other in_progress tasks
          other_active=$(curl -s "$MC_URL/api/tasks" -H "$auth_header" | \
            python3 -c "import json,sys; tasks=json.load(sys.stdin); print(len([t for t in tasks if t.get('assigned_agent_id')=='$agent_id' and t['status']=='in_progress' and t['id']!='$task_id']))" 2>/dev/null || echo "0")
          if [[ "$other_active" == "0" ]]; then
            curl -s -X PATCH "$MC_URL/api/agents/$agent_id" \
              -H "$auth_header" -H "$content_type" \
              -d '{"status": "standby"}' > /dev/null 2>&1
          fi
          ;;
      esac
    fi
    ;;

  list-tasks)
    status_filter="${1:-}"
    result=$(curl -s "$MC_URL/api/tasks" -H "$auth_header")
    if [[ -n "$status_filter" ]]; then
      echo "$result" | python3 -c "
import json,sys
tasks=json.load(sys.stdin)
for t in tasks:
    if t.get('status')=='$status_filter':
        print(f\"{t['id'][:8]}  {t['status']:12} {t.get('priority','?'):8} {t['title']}\")
"
    else
      echo "$result" | python3 -c "
import json,sys
tasks=json.load(sys.stdin)
for t in tasks:
    agent=t.get('assigned_agent_name','unassigned')
    print(f\"{t['id'][:8]}  {t['status']:12} {agent:15} {t['title']}\")
"
    fi
    ;;

  list-agents)
    curl -s "$MC_URL/api/agents" -H "$auth_header" | python3 -c "
import json,sys
agents=json.load(sys.stdin)
for a in agents:
    oc_id = a.get('openclaw_agent_id') or '?'
    print(f\"{a['avatar_emoji']} {a['name']:15} {a['role']:15} {a['status']:10} oc:{oc_id}\")
"
    ;;

  complete-task)
    # All-in-one task completion: log activity + optional deliverable + status → review
    # Usage: mc.sh complete-task TASK_ID "Summary of what was done" ["deliverable title" "deliverable description"]
    task_id_input="${1:?Usage: mc.sh complete-task TASK_ID SUMMARY [DELIVERABLE_TITLE DELIVERABLE_DESC]}"
    summary="${2:?Must provide a summary of what was done}"
    deliverable_title="${3:-}"
    deliverable_desc="${4:-}"

    # Resolve short ID
    if [[ ${#task_id_input} -lt 36 ]]; then
      task_id=$(curl -s "$MC_URL/api/tasks" -H "$auth_header" | \
        python3 -c "import json,sys; tasks=json.load(sys.stdin); matches=[t['id'] for t in tasks if t['id'].startswith('${task_id_input}')]; print(matches[0] if matches else '${task_id_input}')")
    else
      task_id="$task_id_input"
    fi

    # 1. Log completion activity
    curl -s -X POST "$MC_URL/api/tasks/$task_id/activities" \
      -H "$auth_header" -H "$content_type" \
      -d "{\"activity_type\": \"completed\", \"message\": $(python3 -c "import json; print(json.dumps('$summary'))" 2>/dev/null || echo "\"$summary\"")}" > /dev/null

    # 2. Log deliverable if provided
    if [[ -n "$deliverable_title" ]]; then
      curl -s -X POST "$MC_URL/api/tasks/$task_id/deliverables" \
        -H "$auth_header" -H "$content_type" \
        -d "{\"deliverable_type\": \"artifact\", \"title\": $(python3 -c "import json; print(json.dumps('$deliverable_title'))" 2>/dev/null || echo "\"$deliverable_title\""), \"description\": $(python3 -c "import json; print(json.dumps('$deliverable_desc'))" 2>/dev/null || echo "\"$deliverable_desc\"")}" > /dev/null
    fi

    # 3. Move to review (NOT done — done is the human's call)
    result=$(curl -s -X PATCH "$MC_URL/api/tasks/$task_id" \
      -H "$auth_header" -H "$content_type" \
      -d '{"status": "review"}')

    # 4. Sync agent status
    agent_id=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('assigned_agent_id',''))" 2>/dev/null || echo "")
    if [[ -n "$agent_id" ]]; then
      other_active=$(curl -s "$MC_URL/api/tasks" -H "$auth_header" | \
        python3 -c "import json,sys; tasks=json.load(sys.stdin); print(len([t for t in tasks if t.get('assigned_agent_id')=='$agent_id' and t['status']=='in_progress' and t['id']!='$task_id']))" 2>/dev/null || echo "0")
      if [[ "$other_active" == "0" ]]; then
        curl -s -X PATCH "$MC_URL/api/agents/$agent_id" \
          -H "$auth_header" -H "$content_type" \
          -d '{"status": "standby"}' > /dev/null 2>&1
      fi
    fi

    echo "{\"status\": \"review\", \"task_id\": \"$task_id\", \"summary\": \"$summary\"}"
    ;;

  dispatch)
    task_id="${1:?Usage: mc.sh dispatch TASK_ID}"
    curl -s -X POST "$MC_URL/api/tasks/$task_id/dispatch" \
      -H "$auth_header" -H "$content_type"
    ;;

  help|*)
    echo "Mission Control CLI"
    echo ""
    echo "Commands:"
    echo "  create-task TITLE DESC AGENT [PRIORITY]    Create and optionally assign a task"
    echo "  complete-task TASK_ID SUMMARY [TITLE DESC] Complete task: log activity + deliverable + → review"
    echo "  register-subagent TASK_ID SID NAME         Register sub-agent session"
    echo "  log-activity TASK_ID TYPE MSG               Log activity (spawned|updated|completed|file_created)"
    echo "  log-deliverable TASK_ID TYPE TITLE [PATH]   Register deliverable (file|url|artifact)"
    echo "  complete-session SESSION_ID                 Mark session completed"
    echo "  update-status TASK_ID STATUS                Update task status"
    echo "  dispatch TASK_ID                            Dispatch task to assigned agent"
    echo "  list-tasks [STATUS]                         List tasks"
    echo "  list-agents                                 List agents"
    ;;
esac
