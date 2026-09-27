import React, { useState, useEffect, useRef } from 'react';
import { 
  MessageSquare, 
  X, 
  ChevronDown, 
  Maximize2,
  Send,
  Loader2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { SmsThread } from '../types';
import { AIIcon } from './AIIcon';

interface LiveAssistantFloatingProps {
  threads: SmsThread[];
  selectedThreadId: string;
  setSelectedThreadId: (id: string) => void;
  onOpenSmsInbox: () => void;
  onSendMessage: (threadId: string, text: string) => Promise<void>;
}

export const LiveAssistantFloating: React.FC<LiveAssistantFloatingProps> = ({
  threads,
  selectedThreadId,
  setSelectedThreadId,
  onOpenSmsInbox,
  onSendMessage
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeThread = threads.find(t => t.id === selectedThreadId) || threads[0];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeThread?.messages, isExpanded]);

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || isSending || !activeThread) return;

    setIsSending(true);
    try {
      await onSendMessage(activeThread.id, inputText);
      setInputText('');
    } catch (err) {
      console.error('Failed to send message from floating assistant:', err);
    } finally {
      setIsSending(false);
    }
  };

  if (!activeThread) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end pointer-events-none">
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            className="mb-4 w-[380px] bg-white rounded-2xl shadow-2xl border border-neutral-200 overflow-hidden flex flex-col pointer-events-auto h-[560px]"
          >
            {/* Header */}
            <div className="p-4 border-b border-neutral-100 flex items-center justify-between bg-white sticky top-0 z-10">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-neutral-900 flex items-center justify-center">
                  <AIIcon className="h-5 w-5 text-indigo-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-neutral-900 leading-none uppercase tracking-tight font-head">Live Assistant</h3>
                  <p className="text-[10px] text-neutral-500 mt-1 font-medium">Autonomous Dispatch Monitoring</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button 
                  onClick={onOpenSmsInbox}
                  className="p-1.5 hover:bg-neutral-100 rounded-md text-neutral-500 transition-colors"
                  title="Open Full Inbox"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </button>
                <button 
                  onClick={() => setIsExpanded(false)}
                  className="p-1.5 hover:bg-neutral-100 rounded-md text-neutral-500 transition-colors"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Quick Selector */}
            <div className="px-3 py-2 border-b border-neutral-100 flex gap-1.5 overflow-x-auto no-scrollbar bg-neutral-50/50">
              {threads.map(t => (
                <button
                  key={t.id}
                  onClick={() => setSelectedThreadId(t.id)}
                  className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-tighter whitespace-nowrap transition-all ${
                    t.id === selectedThreadId
                      ? 'bg-neutral-900 text-white shadow-md'
                      : 'bg-white border-2 border-neutral-100 text-neutral-400 hover:border-neutral-200'
                  }`}
                >
                  {t.customerName.split(' ')[0]}
                </button>
              ))}
            </div>

            {/* Messages */}
            <div 
              ref={scrollRef}
              className="flex-1 overflow-y-auto p-4 space-y-4 bg-neutral-50/20"
            >
              <div className="text-center mb-2">
                <span className="text-[9px] text-neutral-400 font-black uppercase tracking-widest bg-white border border-neutral-100 px-2 py-0.5 rounded shadow-sm">
                  Conversation with {activeThread.customerName}
                </span>
              </div>

              {activeThread.messages.map((m) => {
                const isCustomer = m.sender === 'customer';
                const isAi = m.sender === 'assistant';
                
                return (
                  <div 
                    key={m.id} 
                    className={`flex flex-col ${isCustomer ? 'items-start' : 'items-end'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[12px] leading-relaxed shadow-sm ${
                        isCustomer
                          ? 'bg-white text-neutral-900 border border-neutral-100 rounded-tl-none font-medium'
                          : isAi
                          ? 'bg-neutral-900 text-white rounded-tr-none font-bold'
                          : 'bg-indigo-600 text-white rounded-tr-none font-bold'
                      }`}
                    >
                      <p>{m.text}</p>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1.5 px-1 opacity-60">
                      <span className="text-[9px] text-neutral-500 font-black uppercase tracking-tighter">
                        {isAi ? 'RidgeLine AI' : isCustomer ? activeThread.customerName : 'You (Mark)'}
                      </span>
                      <span className="text-[9px] text-neutral-300">·</span>
                      <span className="text-[9px] text-neutral-500 font-mono">{m.timestamp}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer / Input */}
            <div className="p-4 border-t border-neutral-100 bg-white">
              <form onSubmit={handleSend} className="flex items-center gap-2">
                <div className="flex-1 relative group">
                  <input
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder="Simulate customer reply..."
                    className="w-full bg-neutral-50 border-2 border-neutral-100 rounded-xl px-4 py-2.5 text-xs font-bold text-neutral-900 placeholder:text-neutral-300 focus:outline-none focus:border-neutral-900 focus:bg-white transition-all"
                    disabled={isSending}
                  />
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-focus-within:opacity-100 transition-opacity">
                    <span className="text-[9px] font-black text-neutral-400 bg-neutral-100 px-1.5 py-0.5 rounded uppercase tracking-tighter">Enter to send</span>
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={!inputText.trim() || isSending}
                  className="h-10 w-10 flex items-center justify-center bg-neutral-900 text-white rounded-xl hover:bg-neutral-800 disabled:opacity-30 transition-all active:scale-90 shadow-lg"
                >
                  {isSending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </button>
              </form>
              <p className="mt-2 text-[9px] text-center text-neutral-400 font-bold uppercase tracking-widest">
                Interactive AI Simulator Mode
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Toggle Bubble */}
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setIsExpanded(!isExpanded)}
        className="pointer-events-auto h-16 w-16 rounded-2xl bg-neutral-900 text-white shadow-2xl flex items-center justify-center hover:bg-neutral-800 transition-colors border-2 border-neutral-700/30 relative group overflow-hidden"
      >
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        {isExpanded ? (
          <ChevronDown className="h-7 w-7 relative z-10" />
        ) : (
          <div className="relative z-10">
            <AIIcon className="h-7 w-7" />
            <div className="absolute -top-1 -right-1 h-4 w-4 bg-indigo-500 border-2 border-neutral-900 rounded-full flex items-center justify-center">
              <div className="h-1.5 w-1.5 bg-white rounded-full animate-pulse" />
            </div>
          </div>
        )}
        
        {/* Tooltip */}
        {!isExpanded && (
          <div className="absolute right-full mr-4 top-1/2 -translate-y-1/2 px-4 py-2 bg-neutral-900 text-white text-[10px] font-black uppercase tracking-widest rounded-xl whitespace-nowrap opacity-0 group-hover:opacity-100 transition-all duration-300 pointer-events-none shadow-2xl border-2 border-neutral-700/30">
            Live AI Stream
            <div className="absolute left-full top-1/2 -translate-y-1/2 w-2 h-2 bg-neutral-900 rotate-45 -ml-1 border-r-2 border-t-2 border-neutral-700/30" />
          </div>
        )}
      </motion.button>
    </div>
  );
};
