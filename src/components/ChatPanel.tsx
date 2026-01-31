'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Users, Plus, X, Zap } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Message, Conversation, Agent, OpenClawHistoryMessage } from '@/lib/types';
import { formatDistanceToNow } from 'date-fns';

export function ChatPanel() {
  const {
    conversations,
    currentConversation,
    setCurrentConversation,
    messages,
    setMessages,
    addMessage,
    agents,
    addEvent,
    agentOpenClawSessions,
    openclawMessages,
    setOpenclawMessages,
  } = useMissionControl();

  const [newMessage, setNewMessage] = useState('');
  const [selectedSender, setSelectedSender] = useState<string>('');
  const [showConversationList, setShowConversationList] = useState(true);
  const [showNewConvoModal, setShowNewConvoModal] = useState(false);
  const [isSendingToOpenClaw, setIsSendingToOpenClaw] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Find if conversation has any OpenClaw-linked agent (other than self)
  const getOpenClawLinkedAgent = useCallback(() => {
    if (!currentConversation?.participants) return null;
    for (const participant of currentConversation.participants) {
      const session = agentOpenClawSessions[participant.id];
      if (session) {
        return { agent: participant, session };
      }
    }
    return null;
  }, [currentConversation?.participants, agentOpenClawSessions]);

  // Load messages when conversation changes
  useEffect(() => {
    if (currentConversation) {
      fetchMessages(currentConversation.id);
      setShowConversationList(false);
    }
  }, [currentConversation?.id]);

  // Poll OpenClaw for messages when conversation has linked agent
  useEffect(() => {
    const linkedAgent = getOpenClawLinkedAgent();

    // Clear existing poll
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    if (!linkedAgent || !currentConversation) {
      setOpenclawMessages([]);
      return;
    }

    // Fetch OpenClaw history immediately
    const fetchOpenClawHistory = async () => {
      try {
        const res = await fetch(`/api/openclaw/sessions/${linkedAgent.session.openclaw_session_id}/history`);
        if (res.ok) {
          const data = await res.json();
          const history = data.history as OpenClawHistoryMessage[];

          // Convert OpenClaw history to Message format
          const convertedMessages: Message[] = history.map((msg, index) => ({
            id: `openclaw-${index}-${msg.timestamp || Date.now()}`,
            conversation_id: currentConversation.id,
            sender_agent_id: msg.role === 'assistant' ? linkedAgent.agent.id : undefined,
            content: msg.content,
            message_type: 'text',
            created_at: msg.timestamp || new Date().toISOString(),
            sender: msg.role === 'assistant' ? linkedAgent.agent : undefined,
            // Mark as OpenClaw message for UI styling
            metadata: JSON.stringify({ source: 'openclaw', role: msg.role }),
          }));

          setOpenclawMessages(convertedMessages);
        }
      } catch (error) {
        console.error('Failed to fetch OpenClaw history:', error);
      }
    };

    fetchOpenClawHistory();

    // Poll every 3 seconds
    pollIntervalRef.current = setInterval(fetchOpenClawHistory, 3000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [currentConversation?.id, getOpenClawLinkedAgent, setOpenclawMessages]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, openclawMessages]);

  const fetchMessages = async (conversationId: string) => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`);
      if (res.ok) {
        const msgs = await res.json();
        setMessages(msgs);
      }
    } catch (error) {
      console.error('Failed to fetch messages:', error);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !currentConversation || !selectedSender) return;

    const linkedAgent = getOpenClawLinkedAgent();
    const messageContent = newMessage;
    setNewMessage('');

    // If conversation has an OpenClaw-linked agent, send via OpenClaw
    if (linkedAgent) {
      setIsSendingToOpenClaw(true);
      try {
        const res = await fetch(`/api/openclaw/sessions/${linkedAgent.session.openclaw_session_id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: messageContent }),
        });

        if (res.ok) {
          const sender = agents.find((a) => a.id === selectedSender);
          if (sender) {
            addEvent({
              id: crypto.randomUUID(),
              type: 'message_sent',
              agent_id: selectedSender,
              message: `${sender.name} sent a message to ${linkedAgent.agent.name} via OpenClaw`,
              created_at: new Date().toISOString(),
            });
          }
        } else {
          console.error('Failed to send message via OpenClaw');
        }
      } catch (error) {
        console.error('Failed to send message via OpenClaw:', error);
      } finally {
        setIsSendingToOpenClaw(false);
      }
      return;
    }

    // Otherwise, send to local DB (existing behavior)
    const tempMessage: Message = {
      id: crypto.randomUUID(),
      conversation_id: currentConversation.id,
      sender_agent_id: selectedSender,
      content: messageContent,
      message_type: 'text',
      created_at: new Date().toISOString(),
      sender: agents.find((a) => a.id === selectedSender),
    };

    // Optimistic update
    addMessage(tempMessage);

    try {
      const res = await fetch(`/api/conversations/${currentConversation.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender_agent_id: selectedSender,
          content: messageContent,
        }),
      });

      if (res.ok) {
        const sender = agents.find((a) => a.id === selectedSender);
        if (sender) {
          addEvent({
            id: crypto.randomUUID(),
            type: 'message_sent',
            agent_id: selectedSender,
            message: `${sender.name} sent a message`,
            created_at: new Date().toISOString(),
          });
        }
      }
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  };

  const linkedAgentInfo = getOpenClawLinkedAgent();

  // Combine and sort messages (local + openclaw) for OpenClaw conversations
  const displayMessages = linkedAgentInfo
    ? openclawMessages // For OpenClaw convos, only show OpenClaw messages
    : messages; // For local convos, show local messages

  if (showConversationList) {
    return (
      <ConversationList
        conversations={conversations}
        onSelect={(conv) => setCurrentConversation(conv)}
        onNewConversation={() => setShowNewConvoModal(true)}
        showNewConvoModal={showNewConvoModal}
        setShowNewConvoModal={setShowNewConvoModal}
      />
    );
  }

  return (
    <div className="flex flex-col h-full bg-mc-bg-secondary">
      {/* Chat Header */}
      <div className="p-3 border-b border-mc-border flex items-center gap-3">
        <button
          onClick={() => setShowConversationList(true)}
          className="p-1 hover:bg-mc-bg-tertiary rounded"
        >
          <Users className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm">
              {currentConversation?.title || 'Conversation'}
            </h3>
            {linkedAgentInfo && (
              <span className="flex items-center gap-1 text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full">
                <Zap className="w-3 h-3" />
                OpenClaw
              </span>
            )}
          </div>
          <p className="text-xs text-mc-text-secondary">
            {currentConversation?.participants?.map((p) => p.name).join(', ')}
          </p>
        </div>
        <button
          onClick={() => {
            setCurrentConversation(null);
            setShowConversationList(true);
          }}
          className="p-1 hover:bg-mc-bg-tertiary rounded"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {displayMessages.map((message) => (
          <MessageBubble key={message.id} message={message} isOpenClaw={!!linkedAgentInfo} />
        ))}
        {displayMessages.length === 0 && linkedAgentInfo && (
          <div className="text-center py-8 text-mc-text-secondary text-sm">
            Send a message to start chatting with {linkedAgentInfo.agent.name} via OpenClaw
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSendMessage} className="p-3 border-t border-mc-border">
        {/* OpenClaw indicator */}
        {linkedAgentInfo && (
          <div className="mb-2 flex items-center gap-2 text-xs text-green-400">
            <Zap className="w-3 h-3" />
            <span>Messages will be sent to {linkedAgentInfo.agent.name} via OpenClaw Gateway</span>
          </div>
        )}

        {/* Sender Selection - hidden for OpenClaw convos since it's always "you" */}
        {!linkedAgentInfo && (
          <div className="mb-2">
            <select
              value={selectedSender}
              onChange={(e) => setSelectedSender(e.target.value)}
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-mc-accent"
            >
              <option value="">Select who's speaking...</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.avatar_emoji} {agent.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            placeholder={linkedAgentInfo ? `Message ${linkedAgentInfo.agent.name}...` : 'Type a message...'}
            className="flex-1 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
            disabled={isSendingToOpenClaw}
          />
          <button
            type="submit"
            disabled={!newMessage.trim() || (!linkedAgentInfo && !selectedSender) || isSendingToOpenClaw}
            className="px-4 py-2 bg-mc-accent text-mc-bg rounded hover:bg-mc-accent/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isSendingToOpenClaw ? (
              <div className="w-4 h-4 border-2 border-mc-bg border-t-transparent rounded-full animate-spin" />
            ) : linkedAgentInfo ? (
              <Zap className="w-4 h-4" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      </form>
    </div>
  );
}

function MessageBubble({ message, isOpenClaw }: { message: Message; isOpenClaw?: boolean }) {
  const sender = message.sender as Agent | undefined;

  // Parse metadata to check if this is an OpenClaw message and get role
  let openclawRole: string | null = null;
  if (message.metadata) {
    try {
      const meta = JSON.parse(message.metadata);
      if (meta.source === 'openclaw') {
        openclawRole = meta.role;
      }
    } catch {
      // Ignore parse errors
    }
  }

  // For OpenClaw user messages (your messages), show differently
  const isYourMessage = openclawRole === 'user';

  return (
    <div className={`flex items-start gap-2 animate-slide-in ${isYourMessage ? 'flex-row-reverse' : ''}`}>
      <div className="text-xl flex-shrink-0">
        {isYourMessage ? '👤' : (sender?.avatar_emoji || '🤖')}
      </div>
      <div className={`flex-1 min-w-0 ${isYourMessage ? 'text-right' : ''}`}>
        <div className={`flex items-baseline gap-2 ${isYourMessage ? 'justify-end' : ''}`}>
          <span className="font-medium text-sm">
            {isYourMessage ? 'You' : (sender?.name || 'Unknown')}
          </span>
          {isOpenClaw && !isYourMessage && (
            <Zap className="w-3 h-3 text-green-400" />
          )}
          <span className="text-xs text-mc-text-secondary">
            {formatDistanceToNow(new Date(message.created_at), { addSuffix: true })}
          </span>
        </div>
        <p className={`text-sm mt-1 text-mc-text whitespace-pre-wrap ${isYourMessage ? 'bg-mc-accent/20 rounded-lg px-3 py-2 inline-block' : ''}`}>
          {message.content}
        </p>
      </div>
    </div>
  );
}

interface ConversationListProps {
  conversations: Conversation[];
  onSelect: (conv: Conversation) => void;
  onNewConversation: () => void;
  showNewConvoModal: boolean;
  setShowNewConvoModal: (show: boolean) => void;
}

function ConversationList({
  conversations,
  onSelect,
  onNewConversation,
  showNewConvoModal,
  setShowNewConvoModal,
}: ConversationListProps) {
  const { agents, setConversations } = useMissionControl();
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [title, setTitle] = useState('');

  const handleCreateConversation = async () => {
    if (selectedAgents.length < 1) return;

    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title || 'New Conversation',
          type: selectedAgents.length > 2 ? 'group' : 'direct',
          participant_ids: selectedAgents,
        }),
      });

      if (res.ok) {
        const newConvo = await res.json();
        setConversations([newConvo, ...conversations]);
        setShowNewConvoModal(false);
        setSelectedAgents([]);
        setTitle('');
        onSelect(newConvo);
      }
    } catch (error) {
      console.error('Failed to create conversation:', error);
    }
  };

  return (
    <div className="flex flex-col h-full bg-mc-bg-secondary">
      <div className="p-3 border-b border-mc-border flex items-center justify-between">
        <h3 className="font-medium text-sm">Conversations</h3>
        <button
          onClick={onNewConversation}
          className="p-1.5 bg-mc-accent text-mc-bg rounded hover:bg-mc-accent/90"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {conversations.map((conv) => (
          <button
            key={conv.id}
            onClick={() => onSelect(conv)}
            className="w-full p-3 text-left rounded hover:bg-mc-bg-tertiary transition-colors"
          >
            <div className="flex items-center gap-2">
              <div className="flex -space-x-1">
                {conv.participants?.slice(0, 3).map((p) => (
                  <span key={p.id} className="text-lg">
                    {p.avatar_emoji}
                  </span>
                ))}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">
                  {conv.title || conv.participants?.map((p) => p.name).join(', ')}
                </p>
                {conv.last_message && (
                  <p className="text-xs text-mc-text-secondary truncate">
                    {conv.last_message.content}
                  </p>
                )}
              </div>
            </div>
          </button>
        ))}

        {conversations.length === 0 && (
          <div className="text-center py-8 text-mc-text-secondary text-sm">
            No conversations yet
          </div>
        )}
      </div>

      {/* New Conversation Modal */}
      {showNewConvoModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-mc-bg-secondary border border-mc-border rounded-lg w-full max-w-md p-4">
            <h3 className="font-semibold mb-4">New Conversation</h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm mb-1">Title (optional)</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Conversation name..."
                  className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                />
              </div>

              <div>
                <label className="block text-sm mb-2">Participants</label>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {agents.map((agent) => (
                    <label
                      key={agent.id}
                      className="flex items-center gap-2 p-2 hover:bg-mc-bg-tertiary rounded cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedAgents.includes(agent.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedAgents([...selectedAgents, agent.id]);
                          } else {
                            setSelectedAgents(selectedAgents.filter((id) => id !== agent.id));
                          }
                        }}
                        className="w-4 h-4"
                      />
                      <span className="text-lg">{agent.avatar_emoji}</span>
                      <span className="text-sm">{agent.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowNewConvoModal(false)}
                className="px-4 py-2 text-sm text-mc-text-secondary hover:text-mc-text"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateConversation}
                disabled={selectedAgents.length < 1}
                className="px-4 py-2 bg-mc-accent text-mc-bg rounded text-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
