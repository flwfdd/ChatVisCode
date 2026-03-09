import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import configGlobal from '@/lib/config';
import { DSLSchema, IDSL, IEdge, IFlowNodeType, INodeType, INodeWithPosition, loadDSL, NodeDSLSchema, EdgeDSLSchema, INodeState, INodeConfig, INodeOutput, INodeInput, dumpDSL, FlowDSLSchema } from '@/lib/flow/flow';
import { reactStream, createExecutableTool, Message, ExecutableTool } from '@/lib/llm';
import { Editor } from '@monaco-editor/react';
import { ChevronDown, ChevronRight, Loader, PanelLeftClose, PanelRightClose, Trash2 } from 'lucide-react';
import { useEffect, useState, useRef } from 'react';
import { toast } from 'sonner';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import MarkdownRenderer from './MarkdownRenderer';

interface ToolCallComponentProps {
  toolCall: {
    id: string;
    name: string;
    arguments: string;
  };
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

function ToolCallComponent({ toolCall, isCollapsed, onToggleCollapse }: ToolCallComponentProps) {
  const formatArguments = (args: string) => {
    if (!args) return '';

    try {
      const parsed = JSON.parse(args);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return args;
    }
  };

  return (
    <div className="p-3 bg-cyan-50 dark:bg-cyan-950/20 rounded border border-cyan-300 dark:border-cyan-800">
      <div
        className="flex items-center justify-between cursor-pointer"
        onClick={onToggleCollapse}
      >
        <div className="flex items-center gap-2">
          <div className="text-xs font-medium text-cyan-700 dark:text-cyan-300">
            🔧 {toolCall.name}
          </div>
        </div>
        {isCollapsed ? (
          <ChevronRight className="h-4 w-4 text-cyan-500" />
        ) : (
          <ChevronDown className="h-4 w-4 text-cyan-500" />
        )}
      </div>

      {!isCollapsed && (
        <div className="mt-2">
          {toolCall.arguments ? (
            <div className="text-xs font-mono rounded break-all">
              {formatArguments(toolCall.arguments)}
            </div>
          ) : (
            <div className="text-xs text-gray-500 italic">Loading parameters...</div>
          )}
        </div>
      )}
    </div>
  );
}

interface AICopilotDialogProps {
  isOpen: boolean;
  onClose: () => void;
  DSL: IDSL;
  setDSL: (dsl: IDSL) => void;
  nodeTypeMap: Record<string, INodeType<INodeConfig, INodeState, INodeInput, INodeOutput>>;
  newFlowNodeType: (id: string, name: string, description: string, nodes: INodeWithPosition[], edges: IEdge[]) => IFlowNodeType;
  setNodeReviewed: (flowId: string, nodeId: string, reviewed: boolean) => void;
}

interface ChatMessage extends Message {
  timestamp: number;
}


function tagContext(dslStr: string, dslErr: string) {
  return `<DSL Context>
DSL:
\`\`\`
${dslStr}
\`\`\`

${dslErr ? `Error:
\`\`\`
${dslErr}
\`\`\`
` : ''}
</DSL Context>`;
}

function removeTagContext(content: string) {
  return content.replace(/<DSL Context>[\s\S]*?<\/DSL Context>/g, '');
}



function AICopilotDialog({
  isOpen,
  onClose,
  DSL,
  setDSL,
  nodeTypeMap,
  newFlowNodeType,
  setNodeReviewed,
}: AICopilotDialogProps) {
  const [dslString, setDslString] = useState(''); // DSL in code editor
  const [prompt, setPrompt] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isShowDSL, setIsShowDSL] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [responseRef, setResponseRef] = useState<HTMLDivElement | null>(null);
  const [dslError, setDslError] = useState('');
  const [collapsedToolCalls, setCollapsedToolCalls] = useState<Set<string>>(new Set());
  const [collapsedToolResults, setCollapsedToolResults] = useState<Set<number>>(new Set());
  const [dslSnapshot, setDslSnapshot] = useState<string>('');

  const dslRef = useRef<IDSL>(DSL); // 最新的有效 DSL

  useEffect(() => {
    if (isOpen) {
      setDslSnapshot(JSON.stringify(DSL, null, 2));
      setChatHistory([]);
      setDslError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]); // DSL更新时不能重置状态

  // 当外部 DSL prop 变化时，同步更新 ref 和编辑器状态
  useEffect(() => {
    if (isOpen) {
      setDslString(JSON.stringify(DSL, null, 2));
    }
  }, [DSL, isOpen]) // 更新

  // Check the DSL
  useEffect(() => {
    try {
      const parsedDSL = JSON.parse(dslString);
      dslRef.current = dumpDSL(loadDSL(parsedDSL, nodeTypeMap, newFlowNodeType));
      setDslError('');
    } catch (error: unknown) {
      setDslError(error instanceof Error ? error.message : String(error));
    }
  }, [dslString, nodeTypeMap, newFlowNodeType]);

  // Auto scroll to bottom of response area
  useEffect(() => {
    if (responseRef && isAiLoading) {
      responseRef.scrollTop = responseRef.scrollHeight;
    }
  }, [chatHistory, responseRef, isAiLoading]);

  const handleAiAction = async () => {
    if (isAiLoading || !prompt.trim()) return;
    setIsAiLoading(true);

    // Helper function to get current DSL
    const getCurrentDSL = () => {
      return dslRef.current;
    };

    // Helper function to update DSL and editor
    const updateDSLAndEditor = (newDSL: unknown, successMessage: string) => {
      try {
        // 验证 DSL
        const validatedDSL = loadDSL(newDSL, nodeTypeMap, newFlowNodeType);

        // 同步更新 ref，供下一次工具调用使用
        dslRef.current = newDSL as IDSL;

        // 异步更新 state，用于 UI 渲染和父组件通信
        const newDSLStr = JSON.stringify(newDSL, null, 2);
        setDslString(newDSLStr);
        setDSL(dumpDSL(validatedDSL));

        toast.success(successMessage);
        return successMessage + ' The flow has been validated and applied.' + '\n\n' + tagContext(newDSLStr, '');
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(error);
        toast.error('DSL validation failed: ' + errorMessage);
        throw new Error(`DSL validation failed: ${errorMessage}`);
      }
    };

    // Define tool parameter schemas
    const EditNodesParamsSchema = z.object({
      flowId: z.string().describe('ID of the flow to edit.'),
      nodes: z.array(NodeDSLSchema).describe('Nodes to create or update')
    });

    const RemoveNodesParamsSchema = z.object({
      flowId: z.string().describe('ID of the flow to edit.'),
      nodeIds: z.array(z.string()).describe('IDs of the nodes to remove')
    });

    const EditEdgesParamsSchema = z.object({
      flowId: z.string().describe('ID of the flow to edit.'),
      edges: z.array(EdgeDSLSchema).describe('Edges to create or update')
    });

    const RemoveEdgesParamsSchema = z.object({
      flowId: z.string().describe('ID of the flow to edit.'),
      edgeIds: z.array(z.string()).describe('IDs of the edges to remove')
    });

    const EditFlowParamsSchema = z.object({
      flowId: z.string().describe('ID of the flow to edit.'),
      flow: FlowDSLSchema.describe('Flow to create or update')
    });

    const RemoveFlowParamsSchema = z.object({
      flowId: z.string().describe('ID of the flow to remove')
    });

    const UpdateDSLParamsSchema = z.object({
      dsl: DSLSchema.describe('Complete DSL to replace the current one')
    });

    const editNodeTool = createExecutableTool(
      'edit_nodes',
      'Create or edit nodes in the flow. If node ID exists, it will be replaced; if not, a new node will be created.',
      EditNodesParamsSchema,
      async (args) => {
        const currentDSL = getCurrentDSL();
        const flowId = args.flowId;

        // Find the target flow in the flows array
        const targetFlow = currentDSL.flows?.find((f: { id: string }) => f.id === flowId);
        if (!targetFlow) {
          throw new Error(`Flow with id "${flowId}" not found`);
        }

        for (const node of args.nodes) {
          // Find existing node index
          const existingIndex = targetFlow.nodes.findIndex((n: { id: string }) => n.id === node.id);

          if (existingIndex >= 0) {
            // Replace existing node
            targetFlow.nodes[existingIndex] = {
              ...node,
              position: node.position || { x: 0, y: 0 }
            };
          } else {
            // Add new node
            targetFlow.nodes.push({
              ...node,
              position: node.position || { x: 0, y: 0 }
            });
          }
        }
        const result = updateDSLAndEditor(currentDSL, `Nodes "${args.nodes.map((node) => node.id).join(', ')}" updated successfully`);
        args.nodes.forEach((node) => setNodeReviewed(flowId, node.id, false));
        return result;
      }
    );

    const removeNodeTool = createExecutableTool(
      'remove_nodes',
      'Remove nodes from the flow and all their connected edges',
      RemoveNodesParamsSchema,
      async (args) => {
        const currentDSL = getCurrentDSL();
        const flowId = args.flowId;

        // Find the target flow in the flows array
        const targetFlow = currentDSL.flows?.find((f: { id: string }) => f.id === flowId);
        if (!targetFlow) {
          throw new Error(`Flow with id "${flowId}" not found`);
        }

        for (const nodeId of args.nodeIds) {
          // Find and remove the node
          const nodeIndex = targetFlow.nodes.findIndex((n: { id: string }) => n.id === nodeId);
          if (nodeIndex === -1) {
            throw new Error(`Node with id "${nodeId}" not found`);
          }

          targetFlow.nodes.splice(nodeIndex, 1);

          // Remove all edges connected to this node
          targetFlow.edges = targetFlow.edges.filter((e: { source: { nodeId: string }, target: { nodeId: string } }) =>
            e.source.nodeId !== nodeId && e.target.nodeId !== nodeId
          );
        }

        return updateDSLAndEditor(currentDSL, `Nodes "${args.nodeIds.join(', ')}" and their connected edges removed successfully`);
      }
    );

    const editEdgeTool = createExecutableTool(
      'edit_edges',
      'Create or edit edges in the flow. If edge ID exists, it will be replaced; if not, a new edge will be created.',
      EditEdgesParamsSchema,
      async (args) => {
        const currentDSL = getCurrentDSL();
        const flowId = args.flowId;

        // Find the target flow in the flows array
        const targetFlow = currentDSL.flows?.find((f: { id: string }) => f.id === flowId);
        if (!targetFlow) {
          throw new Error(`Flow with id "${flowId}" not found`);
        }

        for (const edge of args.edges) {
          // Find existing edge index
          const existingIndex = targetFlow.edges.findIndex((e: { id: string }) => e.id === edge.id);

          if (existingIndex >= 0) {
            // Replace existing edge
            targetFlow.edges[existingIndex] = edge;
          } else {
            // Add new edge
            targetFlow.edges.push(edge);
          }
        }
        const result = updateDSLAndEditor(currentDSL, `Edges "${args.edges.map((edge) => edge.id).join(', ')}" updated successfully`);
        return result;
      }
    );

    // Create the remove_edge tool
    const removeEdgeTool = createExecutableTool(
      'remove_edge',
      'Remove edges from the flow',
      RemoveEdgesParamsSchema,
      async (args) => {
        const currentDSL = getCurrentDSL();
        const flowId = args.flowId;

        // Find the target flow in the flows array
        const targetFlow = currentDSL.flows?.find((f: { id: string }) => f.id === flowId);
        if (!targetFlow) {
          throw new Error(`Flow with id "${flowId}" not found`);
        }

        for (const edgeId of args.edgeIds) {
          // Find and remove the edge
          const edgeIndex = targetFlow.edges.findIndex((e: { id: string }) => e.id === edgeId);
          if (edgeIndex === -1) {
            throw new Error(`Edge with id "${edgeId}" not found`);
          }

          targetFlow.edges.splice(edgeIndex, 1);
        }

        return updateDSLAndEditor(currentDSL, `Edge "${args.edgeIds.join(', ')}" removed successfully`);
      }
    );

    const editFlowTool = createExecutableTool(
      'edit_flow',
      'Create or edit a flow in the DSL',
      EditFlowParamsSchema,
      async (args) => {
        const currentDSL = getCurrentDSL();
        const flowId = args.flowId;

        // Find the target flow
        const targetFlowIndex = currentDSL.flows?.findIndex((f: { id: string }) => f.id === flowId);
        if (targetFlowIndex !== undefined && targetFlowIndex >= 0) {
          // Replace existing flow
          currentDSL.flows[targetFlowIndex] = {
            ...args.flow,
            nodes: args.flow.nodes.map(node => ({
              ...node,
              position: node.position || { x: 0, y: 0 }
            }))
          };
          const result = updateDSLAndEditor(currentDSL, `Flow "${args.flow.id}" updated successfully`);
          args.flow.nodes.forEach((node) => setNodeReviewed(flowId, node.id, false));
          return result;
        } else {
          // Add new flow
          currentDSL.flows.push({
            ...args.flow,
            nodes: args.flow.nodes.map(node => ({
              ...node,
              position: node.position || { x: 0, y: 0 }
            }))
          });
          const result = updateDSLAndEditor(currentDSL, `Flow "${args.flow.id}" created successfully`);
          args.flow.nodes.forEach((node) => setNodeReviewed(flowId, node.id, false));
          return result;
        }
      }
    );

    const removeFlowTool = createExecutableTool(
      'remove_flow',
      'Remove a flow from the DSL',
      RemoveFlowParamsSchema,
      async (args) => {
        const currentDSL = getCurrentDSL();
        const flowId = args.flowId;

        // Find the target flow
        const targetFlowIndex = currentDSL.flows?.findIndex((f: { id: string }) => f.id === flowId);
        if (targetFlowIndex !== undefined && targetFlowIndex >= 0) {
          currentDSL.flows.splice(targetFlowIndex, 1);
          return updateDSLAndEditor(currentDSL, `Flow "${args.flowId}" removed successfully`);
        }
        throw new Error(`Flow with id "${args.flowId}" not found`);
      }
    );

    const updateDSLTool = createExecutableTool(
      'update_dsl',
      'Update the current flow DSL with a new or modified DSL',
      UpdateDSLParamsSchema,
      async (args) => {
        const result = updateDSLAndEditor(args.dsl, 'DSL updated successfully');
        args.dsl.flows?.forEach((flow) => flow.nodes.forEach((node) => setNodeReviewed(flow.id, node.id, false)));
        return result;
      }
    );

    const systemPrompt = `You are an expert AI assistant for collaboratively building visual application flows.
Your primary role is to help users analyze, create, and modify these flows based on their instructions and the provided DSL context.
Your goal is to be a collaborative, precise, and safe assistant. Always prioritize understanding the user's intent and work iteratively.
Use the user's language for explanations and diagrams, but must keep all parameters and variable names in English.

# Core Principles
1. Clarify First, Never Assume: If any part of the user's request is unclear or ambiguous, you MUST ask for clarification before proceeding. Do not make assumptions about the user's intent.
2. Plan and Iterate, Don't Monologue: For new or complex requests, first propose a clear plan of action. Wait for user confirmation before proceeding.
3. Visualize with Mermaid: Use Mermaid flowchart diagrams (flowchart TD, wrap with \`\`\`mermaid) as a communication tool. Sketch out your plan and show the updated structure after significant changes to ensure alignment with the user. Hint: Node ID in flowchart can't be reserved words, like start, end, etc.
4. Use Tools, Don't Print DSL: You MUST use the provided tools to modify the flow. NEVER output the raw DSL JSON in your response.

# Standard Workflow
1. Acknowledge & Clarify: Acknowledge the user's request. If there's any ambiguity, ask clarifying questions immediately.
2. Propose a Plan: Explain your plan in detail: what the flow will do, the nodes you'll use, and the overall logic.
3. Sketch with Mermaid: Provide a simple Mermaid diagram to visualize the proposed structure.
4. Await Confirmation: Wait for the user to approve the plan before making any changes.
5. Execute with Tools: Once approved, use the appropriate tools to build the flow.
6. Confirm Completion: Announce when the task is complete and summary.

# Tool Usage Guidelines
- All tool calls must generate a valid format that strictly follows the provided schema and rules. Ensure all node/edge IDs are unique and connections are valid.
- For small, targeted modifications (e.g., editing one node's config, adding a single edge), prefer specific tools like edit_node or add_edge.
- For creating a whole new flow or making large-scale changes, the update_dsl and edit_flow tool is appropriate.
- Always choose the appropriate tools to make the changes shorter, concise, clear and faster. For example, if you want to add lots of nodes and edges, you should use the update_dsl or edit_flow tool.
- Stop calling tools only when the target is reached or you need help.


# DSL Context

All changes must ensure the DSL:
- **Strictly follow the DSL structure**
- **The DSL is complete and valid**
- **Every node ID is unique**
- **All connections follow the rules**
- **Handle IDs match the node specifications exactly**

## Flow Structure
- A flow has a unique id, a name, a description, and a list of nodes and edges
- Every flow has and only has one start node (id: start, type: start) and one end node (id: end, type: end)
- Every flow can run independently or be a subflow of another flow or be a tool of Agent node.
- The params of start node is the input of the flow, the value of the end node is the output of the flow, so the end node should be connected to at least one edge
- The type of a node can be another flow id (as a subflow), but there can not be a circular reference

## Node Structure
- A node has a unique id, a type, a config, and a position
- The type can be one of the node type id or a flow id
- A node can connect to zero or more input/output edges through handles, every handle has a unique key, which is defined strictly by the node type input/output schema or dynamically by the node config
- Every output handle of a node (source of an edge) can connect to multiple input handles (targets of edges), but every input handle can only connect to one output handle (except the end node)
- For some node types, the input/output handles are dynamic, you must make sure the handle keys are valid

## Edge Structure
- An edge has a unique id, a source and a target
- The source and target are the handle of the node
- The nodeId and the key of the handle must match exactly with node specifications

## Connection Rules
Example:
We use [input handle]node[output handle] to represent the connection.
- Forbidden to connect to nonexistent static handle: text[text] → [value]display[NO HANDLE] → [value]end is illegal, because display has no output handle. You can connect them separately like text[text] → display & text[text] → [value]end.
- Forbidden to connect to nonexistent dynamic handle: start[value] → [value]display is illegal if there is no 'value' param in the flow node config. You can add a 'value' param in the flow node config before connect them.

## Flow DSL Structure
The DSL is a JSON object with the following schema:
\`\`\`
${JSON.stringify(zodToJsonSchema(DSLSchema, { name: 'dsl', $refStrategy: 'none' }), null, 2)}
\`\`\`

## Node Types
${Object.values(nodeTypeMap).map(nodeType => `
### ID
${nodeType.id}

### Description
${nodeType.description}

### Input Schema
\`\`\`json
${JSON.stringify(zodToJsonSchema(nodeType.inputSchema, { name: nodeType.id, $refStrategy: 'none' }), null, 2)}
\`\`\`

### Output Schema
\`\`\`json
${JSON.stringify(zodToJsonSchema(nodeType.outputSchema, { name: nodeType.id, $refStrategy: 'none' }), null, 2)}
\`\`\`

### Config Schema
\`\`\`json
${JSON.stringify(zodToJsonSchema(nodeType.configSchema, { name: nodeType.id, $refStrategy: 'none' }), null, 2)}
\`\`\`
`).join('\n\n')}

`;

    try {
      // Build conversation history messages
      const newChatHistory: ChatMessage[] = [
        ...chatHistory,
        {
          role: 'user',
          content: prompt.trim() + '\n\n' + tagContext(dslString, dslError),
          timestamp: Date.now()
        }];
      setChatHistory(newChatHistory);
      setPrompt(''); // Clear input

      const messages: Message[] = [
        { role: 'system', content: systemPrompt },
        ...newChatHistory,
      ];

      // Use reactStream function with tools to get streaming events
      const eventStream = reactStream(configGlobal.codeEditorModel, messages, [
        editNodeTool,
        removeNodeTool,
        editEdgeTool,
        removeEdgeTool,
        editFlowTool,
        removeFlowTool,
        updateDSLTool,
      ] as unknown as ExecutableTool<Record<string, unknown>>[], 10);

      for await (const event of eventStream) {
        switch (event.type) {
          case 'llm_start':
            // 创建新的助手消息
            setChatHistory(prev => [...prev, {
              role: 'assistant',
              content: '',
              timestamp: Date.now()
            }]);
            break;

          case 'llm_chunk':
            // 流式更新助手消息内容和 tool calls
            setChatHistory(prev => {
              const newHistory = [...prev];
              const lastMessage = { ...newHistory[newHistory.length - 1] };
              if (lastMessage && lastMessage.role === 'assistant') {
                const chunk = event.chunk;

                // 更新内容
                if (chunk?.content) {
                  lastMessage.content += chunk.content;
                }

                // 更新 tool calls
                const toolCalls = [...(lastMessage.tool_calls || [])];
                if (chunk?.tool_calls) {
                  for (const toolCallDelta of chunk.tool_calls) {
                    const index = toolCallDelta.index;
                    if (index !== undefined) {
                      // 确保数组有足够的位置
                      while (toolCalls.length <= index) {
                        toolCalls.push({
                          id: '',
                          name: '',
                          arguments: '',
                        });
                      }

                      const toolCall = { ...toolCalls[index] };
                      if (toolCallDelta.id) {
                        toolCall.id = toolCallDelta.id;
                      }

                      if (toolCallDelta.function?.name) {
                        toolCall.name += toolCallDelta.function.name;
                      }

                      if (toolCallDelta.function?.arguments) {
                        toolCall.arguments += toolCallDelta.function.arguments;
                      }
                      toolCalls[index] = toolCall;
                    }
                  }
                }
                lastMessage.tool_calls = toolCalls;
              }
              newHistory[newHistory.length - 1] = lastMessage;
              return newHistory;
            });
            break;

          case 'llm_end':
            // 标记助手消息流式传输完成，并标记 tool calls 完成
            setChatHistory(prev => {
              const newHistory = [...prev];
              const lastMessage = newHistory[newHistory.length - 1];
              if (lastMessage && lastMessage.role === 'assistant') {
                lastMessage.content = event.message.content || lastMessage.content;
                lastMessage.tool_calls = event.message.tool_calls?.map(tc => ({
                  id: tc.id,
                  name: tc.name,
                  arguments: tc.arguments
                })) || lastMessage.tool_calls;
              }
              newHistory[newHistory.length - 1] = lastMessage;
              return newHistory;
            });
            break;

          case 'tool_start':
            // 创建新的工具结果消息（只用于显示执行结果）
            setChatHistory(prev => [...prev, {
              role: 'tool',
              content: `Executing tool: ${event.tool_call.name}...`,
              timestamp: Date.now()
            }]);
            break;

          case 'tool_end':
            // 更新工具调用消息的结果
            setChatHistory(prev => {
              const newHistory = [...prev];
              const lastMessage = newHistory[newHistory.length - 1];
              if (lastMessage && lastMessage.role === 'tool') {
                lastMessage.tool_call_id = event.message.tool_call_id;
                lastMessage.content = event.message.content || '';
              }
              return newHistory;
            });
            break;

          case 'end':
            // React 流程结束
            setChatHistory(prev => prev.map(m => ({ ...m, content: removeTagContext(m.content || '') })));
            break;
        }
      }

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error('AI processing failed: ' + errorMessage);
      setChatHistory(prev => [...prev, {
        role: 'assistant',
        content: 'Error: ' + errorMessage,
        timestamp: Date.now()
      }]);
    } finally {
      setIsAiLoading(false);
    }
  };

  const clearChatHistory = () => {
    setChatHistory([]);
    setCollapsedToolCalls(new Set());
    toast.success('Chat history cleared');
  };

  const toggleToolCallCollapse = (toolCallId: string) => {
    setCollapsedToolCalls(prev => {
      const newSet = new Set(prev);
      if (newSet.has(toolCallId)) {
        newSet.delete(toolCallId);
      } else {
        newSet.add(toolCallId);
      }
      return newSet;
    });
  };

  const toggleToolResultCollapse = (messageIndex: number) => {
    setCollapsedToolResults(prev => {
      const newSet = new Set(prev);
      if (newSet.has(messageIndex)) {
        newSet.delete(messageIndex);
      } else {
        newSet.add(messageIndex);
      }
      return newSet;
    });
  };

  const handleSave = () => {
    try {
      // Parse the current DSL string in the editor
      const parsedDSL = JSON.parse(dslString);

      // Try to load the DSL to validate it
      try {
        // Use loadDSL to validate if the DSL is valid
        loadDSL(parsedDSL, nodeTypeMap, newFlowNodeType);

        // If validation passes, call setDSL to update the flow
        setDSL(parsedDSL);
        onClose();
        toast.success('Flow successfully updated');
      } catch (validationError: unknown) {
        const errorMessage = validationError instanceof Error ? validationError.message : String(validationError);
        toast.error('DSL validation failed: ' + errorMessage);
      }
    } catch {
      toast.error('JSON parsing failed, please check the format');
    }
  };

  const handleCancel = () => {
    // Restore the DSL snapshot and update the flow
    setDslString(dslSnapshot);
    setDslError('');

    // Parse and apply the snapshot to restore the original flow
    try {
      const snapshotDSL = JSON.parse(dslSnapshot);
      setDSL(snapshotDSL);
    } catch (error) {
      console.error('Failed to restore DSL snapshot:', error);
    }

    onClose();
    toast.info('Changes discarded, restored to original state');
  };

  // If not open, don't render anything
  if (!isOpen) {
    return null;
  }

  return (
    <div className={`fixed top-0 right-0 h-full ${isShowDSL ? 'w-full' : 'w-96'} bg-background border-l shadow-lg flex flex-col z-50`}>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <h2 className="text-lg font-semibold">AI Agent</h2>
        <Button variant="ghost" size="icon" onClick={() => setIsShowDSL(!isShowDSL)} title="Toggle DSL Editor">
          {isShowDSL ? <PanelRightClose /> : <PanelLeftClose />}
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-row gap-2 overflow-hidden min-h-0 p-4">
        {isShowDSL && (
          <div className="flex-1 flex flex-col overflow-hidden border rounded-md">
            <Editor
              language="json"
              value={dslString}
              onChange={(value) => setDslString(value || '')}
              theme="vs-dark"
            />
          </div>
        )}

        <div className={`flex flex-col gap-2 ${isShowDSL ? 'w-1/2 px-2' : 'w-full'}`}>
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium">Chat History</span>
            {chatHistory.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearChatHistory} title="Clear Chat History">
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>

          <div
            ref={setResponseRef}
            className="flex-1 min-h-0 overflow-auto border rounded-md px-4 py-2 text-sm space-y-4"
          >
            {chatHistory.length === 0 ? (
              <div className="text-muted-foreground my-4">
                You can ask the AI to explain the current flow, modify an existing flow, or create a new flow. For example:
                <ul className="list-disc pl-8 mt-2 space-y-1">
                  <li>Analyze the functionality and structure of this flow</li>
                  <li>Add a new Agent node to the current flow</li>
                  <li>Create a web crawler flow</li>
                  <li>Create an image processing flow</li>
                </ul>
              </div>
            ) : (
              chatHistory.map((message, index) => (
                <div key={index} className={`p-3 rounded-lg ${message.role === 'user'
                  ? 'bg-primary/10 ml-8'
                  : message.role === 'tool'
                    ? 'bg-orange-50 dark:bg-orange-900/20 mx-4 border border-orange-200 dark:border-orange-700'
                    : 'bg-muted/50 mr-8'
                  }`}>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-medium">
                      {message.role === 'user'
                        ? 'User'
                        : message.role === 'tool'
                          ? 'Tool Result'
                          : 'Agent'}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {new Date(message.timestamp).toLocaleTimeString()}
                      </span>
                      {message.role === 'tool' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-4 w-4 p-0"
                          onClick={() => toggleToolResultCollapse(index)}
                        >
                          {collapsedToolResults.has(index) ? (
                            <ChevronRight className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="text-sm">
                    {message.role === 'user' ? (
                      <div className="whitespace-pre-wrap">{removeTagContext(message.content || '')}</div>
                    ) : message.role === 'tool' ? (
                      <div>
                        {!collapsedToolResults.has(index) && (
                          <div className="whitespace-pre-wrap">{removeTagContext(message.content || '')}</div>
                        )}
                      </div>
                    ) : (
                      <div>
                        <MarkdownRenderer content={removeTagContext(message.content || '')} />
                        {message.tool_calls && message.tool_calls.length > 0 && (
                          <div className="mt-3 space-y-2">
                            {message.tool_calls.map((toolCall, tcIndex) => (
                              <ToolCallComponent
                                key={toolCall.id || tcIndex}
                                toolCall={toolCall}
                                isCollapsed={collapsedToolCalls.has(toolCall.id)}
                                onToggleCollapse={() => toggleToolCallCollapse(toolCall.id)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
            {isAiLoading && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader className="h-4 w-4 animate-spin" />
                <span>AI is thinking...</span>
              </div>
            )}
          </div>

          {dslError && (
            <div className="flex flex-col gap-2">
              <div className="border rounded-md p-2 bg-red-600/10 overflow-y-auto max-h-24">
                <pre className="text-wrap break-words text-red-600 text-sm">{dslError}</pre>
              </div>
              <Button variant="outline" onClick={() => handleAiAction()}>
                Fix with AI
              </Button>
            </div>
          )}

          <Textarea
            placeholder="Describe what you want to do with the flow..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="resize-none min-w-0 h-24"
            disabled={isAiLoading}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                handleAiAction();
              }
            }}
          />
          <Button
            type="button"
            onClick={() => handleAiAction()}
            disabled={isAiLoading || !prompt.trim()}
          >
            {isAiLoading ? (
              <>
                <Loader className="animate-spin" /> Generating...
              </>
            ) : (
              `Send`
            )}
          </Button>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 p-4 border-t">
        <Button type="button" variant="outline" onClick={handleCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={handleSave}>
          Save
        </Button>
      </div>
    </div>
  );
}

export default AICopilotDialog; 