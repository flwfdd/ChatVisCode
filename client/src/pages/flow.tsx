import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  ControlButton,
  Edge,
  MiniMap,
  Node,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  Connection,
  NodeTypes,
} from '@xyflow/react';
import { EllipsisVertical, FileDown, FileUp, LayoutDashboard, Loader, Moon, PanelLeftClose, PanelRightClose, PlayCircle, Plus, ScrollText, Sparkles, Sun, SunMoon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import '@xyflow/react/dist/style.css';

import { EndNodeType } from "@/components/flow/base/EndNode";
import { newFlowNodeType } from '@/components/flow/base/FlowNode';
import { StartNodeType } from "@/components/flow/base/StartNode";
import { BranchNodeType } from '@/components/flow/BranchNode';
import { DisplayNodeType } from "@/components/flow/DisplayNode";
import AICopilotDialog from '@/components/flow/editor/AICopilotDialog';
import EditInfoDialog from '@/components/flow/editor/EditInfoDialog';
import MarkdownRenderer from "@/components/flow/editor/MarkdownRenderer";
import { ImageNodeType } from '@/components/flow/ImageNode';
import { JavaScriptNodeType } from "@/components/flow/JavaScriptNode";
import TimelineLog from "@/components/flow/log/TimelineLog";
import { PythonNodeType } from '@/components/flow/PythonNode';
import { TextNodeType } from '@/components/flow/TextNode';
import { AgentNodeType } from "@/components/flow/AgentNode";
import { useTheme } from "@/components/theme-provider";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { Textarea } from "@/components/ui/textarea";
import configGlobal from "@/lib/config";
import { defaultNodeRunState, dumpDSL, dumpFlow, IDSL, IEdge, IFlowNodeState, IFlowNodeType, INode, INodeConfig, INodeInput, INodeOutput, INodeState, INodeStateRun, INodeType, INodeWithPosition, IRunFlowStack, loadDSL, runFlow } from '@/lib/flow/flow';
import { getLayoutedElements } from '@/lib/flow/layout';
import { llmStream } from '@/lib/llm';
import { generateId } from '@/lib/utils';
import { toast } from 'sonner';
import { JsonNodeType } from '@/components/flow/JsonNode';
import { useFlowNodeTypes } from '@/lib/flow/use-flow-node-types';

// 注册节点类型
const basicNodeTypes = [AgentNodeType, TextNodeType, JsonNodeType, DisplayNodeType, ImageNodeType, JavaScriptNodeType, PythonNodeType, BranchNodeType];
const specialNodeTypes = [StartNodeType, EndNodeType];


// 初始化节点和边
const initialNodes: Node[] = [
  {
    id: 'start',
    type: 'start',
    position: { x: 50, y: 50 },
    data: {
      config: StartNodeType.defaultConfig,
      state: StartNodeType.defaultState,
      runState: defaultNodeRunState,
    },
    deletable: false,
  },
  {
    id: 'end',
    type: 'end',
    position: { x: 400, y: 200 },
    data: {
      config: EndNodeType.defaultConfig,
      state: EndNodeType.defaultState,
      runState: defaultNodeRunState,
    },
    deletable: false,
  },
];
const initialEdges: Edge[] = [];

const initialFlowNodeType: IFlowNodeType = newFlowNodeType("flow_main", "Main Flow", "Main flow", [], [])

function Flow() {
  const { flowNodeTypes, setFlowNodeTypes } = useFlowNodeTypes();
  useEffect(() => {
    if (flowNodeTypes.length === 0) {
      setFlowNodeTypes([initialFlowNodeType]);
    }
  }, [flowNodeTypes, setFlowNodeTypes]);

  // 注册节点类型
  const allNodeTypes = useMemo(() => [...basicNodeTypes, ...specialNodeTypes, ...flowNodeTypes], [flowNodeTypes]);
  const nodeTypeMap = useMemo(() => allNodeTypes.reduce<Record<string, INodeType<INodeConfig, INodeState, INodeInput, INodeOutput>>>((acc, nodeType) => {
    acc[nodeType.id] = nodeType as INodeType<INodeConfig, INodeState, INodeInput, INodeOutput>
    return acc;
  }, {}), [allNodeTypes]);

  // 注册节点UI供ReactFlow使用
  const nodeTypeUIMap = useMemo(() => allNodeTypes.reduce<Record<string, React.ComponentType<unknown>>>((acc, nodeType) => {
    acc[nodeType.id] = nodeType.ui as React.ComponentType<unknown>;
    return acc;
  }, {}), [allNodeTypes]);


  // ReactFlow
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const { screenToFlowPosition, updateNodeData, fitView, getNodes, getEdges } = useReactFlow();

  const [editingFlowId, setEditingFlowId] = useState<string>(initialFlowNodeType.id);

  // 主题
  const { isDarkMode, setTheme, theme } = useTheme();

  // 文件输入
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 对话框
  const [isEditFlowDialogOpen, setIsEditFlowDialogOpen] = useState(false);
  const [editingFlowInfoType, setEditingFlowInfoType] = useState<IFlowNodeType | null>(null);

  const [isDeleteFlowDialogOpen, setIsDeleteFlowDialogOpen] = useState(false);
  const [deletingFlowType, setDeletingFlowType] = useState<IFlowNodeType | null>(null);

  const [isRunLogDialogOpen, setIsRunLogDialogOpen] = useState(false);
  const [isAICopilotDialogOpen, setIsAICopilotDialogOpen] = useState(false);

  // 连接边
  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge({ ...params }, eds)),
    [setEdges],
  );

  // 拖拽添加节点
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      // 获取节点类型
      const type = event.dataTransfer.getData('application/reactflow');
      if (!nodeTypeMap[type]) return;

      // 获取节点位置
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      // 生成节点ID
      const id = generateId();
      // 创建节点
      const newNode = {
        id: id,
        type: type,
        position,
        data: {
          config: nodeTypeMap[type].defaultConfig,
          state: nodeTypeMap[type].defaultState,
          runState: defaultNodeRunState,
        },
      };
      // 添加节点
      setNodes((nds) => nds.concat(newNode));
    },
    [nodeTypeMap, screenToFlowPosition, setNodes]
  );

  // 拖拽节点时
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  // 将节点转换为运行时节点
  const toINode = useCallback((node: Node, withRunState: boolean = false, withPosition: boolean = true) => ({
    id: node.id,
    type: nodeTypeMap[node.type as string],
    config: node.data.config,
    state: node.data.state,
    runState: withRunState ? node.data.runState : structuredClone(defaultNodeRunState),
    position: withPosition ? node.position : undefined,
  } as INodeWithPosition), [nodeTypeMap]);

  // 将边转换为运行时边
  const toIEdge = useCallback((edge: Edge) => {
    const sourceNode = nodes.find((node) => node.id === edge.source);
    const targetNode = nodes.find((node) => node.id === edge.target);
    if (!sourceNode || !targetNode) return null;
    return {
      id: edge.id,
      source: {
        node: toINode(sourceNode) as INode,
        key: edge.sourceHandle
      },
      target: {
        node: toINode(targetNode) as INode,
        key: edge.targetHandle
      }
    };
  }, [nodes, toINode]);

  const fromIDSLNode = useCallback((node: INodeWithPosition): Node => ({
    id: node.id,
    type: node.type.id,
    position: node.position,
    data: {
      config: node.config,
      state: node.state,
      runState: node.runState,
    },
    deletable: node.type.id !== 'start' && node.type.id !== 'end',
  }), []);

  const fromIDSLEdge = useCallback((edge: IEdge): Edge => ({
    id: edge.id,
    source: edge.source.node.id,
    target: edge.target.node.id,
    sourceHandle: edge.source.key,
    targetHandle: edge.target.key,
  }), []);

  // 运行流
  const handleRun = useCallback(() => {
    const iNodes = nodes.map((node) => toINode(node));
    const iEdges = edges.map((edge) => toIEdge(edge)).filter((edge): edge is IEdge => edge !== null);
    const updateConfig = (nodeId: string, config: INodeConfig) => updateNodeData(nodeId, { config: structuredClone(config) });
    const updateState = (nodeId: string, state: INodeState) => updateNodeData(nodeId, { state: structuredClone(state) });
    const updateRunState = (nodeId: string, runState: INodeStateRun<INodeInput, INodeOutput>) => updateNodeData(nodeId, { runState: structuredClone(runState) });
    const flowStack: IRunFlowStack[] = [{
      flow: {
        id: 'main',
        name: 'Main',
        description: 'Main flow',
        nodes: iNodes,
        edges: iEdges,
      },
      startTime: Date.now(),
    }];
    runFlow({}, iNodes, iEdges, updateConfig, updateState, updateRunState, flowStack)
      .then(() => {
        toast.success('Flow run success');
      })
      .catch((error: Error) => {
        toast.error(error.message);
        console.error('Flow run error', error);
      });
  }, [nodes, edges, updateNodeData, toINode, toIEdge]);

  // 自动布局
  const onLayout = useCallback((direction: 'TB' | 'LR' = 'TB') => {
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      nodes,
      edges,
      { direction }
    );

    setNodes([...layoutedNodes]);
    setEdges([...layoutedEdges]);

    window.requestAnimationFrame(() => {
      fitView();
    });
  }, [nodes, edges, setNodes, setEdges, fitView]);

  // 处理Flow AI Dialog
  const handleOpenAICopilotDialog = useCallback(() => {
    setIsAICopilotDialogOpen(true);
  }, []);

  // 导入流
  const importDSL = useCallback((dsl: IDSL, autoLayout: boolean = false) => {
    const { mainFlowId, flowNodeTypes } = loadDSL(dsl, nodeTypeMap, newFlowNodeType);
    const mainFlow = flowNodeTypes.find(flow => flow.id === mainFlowId);
    if (!mainFlow) {
      throw new Error(`Main flow with ID "${mainFlowId}" not found`);
    }

    const newNodes = mainFlow.nodes.map(fromIDSLNode);
    const newEdges = mainFlow.edges.map(fromIDSLEdge);

    setNodes(newNodes);
    setEdges(newEdges);
    setFlowNodeTypes(flowNodeTypes);

    if (autoLayout) {
      setTimeout(() => {
        // 获取最新的节点（包含measured尺寸）
        const currentNodes = getNodes();
        const currentEdges = getEdges();

        const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
          currentNodes.length > 0 ? currentNodes : newNodes,
          currentEdges.length > 0 ? currentEdges : newEdges,
          { direction: 'LR' }
        );

        setNodes([...layoutedNodes]);
        setEdges([...layoutedEdges]);

        window.requestAnimationFrame(() => {
          fitView();
        });
      }, 100);
    } else {
      window.requestAnimationFrame(() => {
        fitView();
      });
    }
  }, [nodeTypeMap, setNodes, setEdges, setFlowNodeTypes, fromIDSLNode, fromIDSLEdge, fitView, getNodes, getEdges]);

  const handleDSLUpdate = useCallback((dsl: IDSL) => {
    try {
      importDSL(dsl, true);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("handleDSLUpdate error", errorMessage);
    }
  }, [importDSL]);

  // 获取当前流的DSL
  const exportDSL = useCallback(() => {
    // 由于循环引用问题，不能直接调用saveEditingFlow，所以需要创建一个临时的flowNodeTypes
    const tempFlowNodeTypes = [...flowNodeTypes];
    const tempEditingFlow = tempFlowNodeTypes.find(ft => ft.id === editingFlowId);
    if (tempEditingFlow) {
      tempEditingFlow.nodes = nodes.map((node) => toINode(node));
      tempEditingFlow.edges = edges.map(toIEdge).filter((edge): edge is IEdge => edge !== null);
    }

    return dumpDSL({
      mainFlowId: editingFlowId,
      flowNodeTypes: tempFlowNodeTypes,
    });
  }, [editingFlowId, flowNodeTypes, nodes, edges, toINode, toIEdge]);

  // 导出流
  const handleExport = useCallback(() => {
    // 导出为json
    const flowDSLJSON = JSON.stringify(exportDSL(), null, 2);
    const blob = new Blob([flowDSLJSON], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const fileName = `flow_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportDSL]);

  // 打开文件选择器
  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // 处理导入文件
  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const dsl: IDSL = JSON.parse(String(e.target?.result));
        importDSL(dsl);
        toast.success('Flow import success!');
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Flow import error", errorMessage);
        toast.error(`Flow import error: ${errorMessage || 'Invalid JSON format'}`);
      } finally {
        // 重置文件输入值以允许重新选择相同的文件
        if (event.target) {
          event.target.value = '';
        }
      }
    };
    reader.onerror = () => {
      toast.error('File read error.');
      // 重置文件输入值
      if (event.target) {
        event.target.value = '';
      }
    };
    reader.readAsText(file);
  }, [importDSL]);


  const handleOpenEditFlowInfoDialog = useCallback((flowType: IFlowNodeType) => {
    setEditingFlowInfoType(flowType);
    setIsEditFlowDialogOpen(true);
  }, [setEditingFlowInfoType, setIsEditFlowDialogOpen]);

  const handleSaveEditFlowInfo = useCallback((name: string, description: string) => {
    if (!editingFlowInfoType) return;
    setFlowNodeTypes(prevTypes =>
      prevTypes.map(ft => {
        if (ft.id === editingFlowInfoType.id) {
          ft.name = name;
          ft.description = description;
        }
        return ft;
      })
    );
    setIsEditFlowDialogOpen(false);
    setEditingFlowInfoType(null);
    toast.success(`Flow info updated.`);
  }, [editingFlowInfoType, setFlowNodeTypes, setIsEditFlowDialogOpen, setEditingFlowInfoType]);

  const handleOpenDeleteFlowDialog = useCallback((flowType: IFlowNodeType) => {
    setDeletingFlowType(flowType);
    setIsDeleteFlowDialogOpen(true);
  }, [setDeletingFlowType, setIsDeleteFlowDialogOpen]);

  const handleConfirmDeleteFlow = useCallback(() => {
    if (!deletingFlowType) return;
    setFlowNodeTypes(prevTypes =>
      prevTypes.filter(ft => ft.id !== deletingFlowType.id)
    );
    // TODO: Also remove nodes of this type from the canvas? Optional, might be complex.
    // setNodes(nds => nds.filter(n => n.type !== deletingFlowType.id));
    setIsDeleteFlowDialogOpen(false);
    toast.warning(`Flow "${deletingFlowType.name}" deleted.`);
    setDeletingFlowType(null);
  }, [deletingFlowType, setFlowNodeTypes, setIsDeleteFlowDialogOpen, setDeletingFlowType]);

  const setNodeReviewed = useCallback((flowId: string, nodeId: string, reviewed: boolean) => {
    if (flowId !== editingFlowId) return;
    setTimeout(() => {
      updateNodeData(nodeId, (node) => ({
        state: {
          ...(node.data.state as INodeState),
          reviewed: reviewed,
        },
      }));
    }, 100);
  }, [editingFlowId, updateNodeData]);

  const highlightNode = useCallback((nodeId: string) => {
    // 关闭Log Dialog
    setIsRunLogDialogOpen(false);
    // 设置高亮
    updateNodeData(nodeId, (node) => ({
      state: {
        ...(node.data.state as INodeState),
        highlight: true,
      },
    }));
    // 5秒后取消高亮
    setTimeout(() => {
      updateNodeData(nodeId, (node) => ({
        state: {
          ...(node.data.state as INodeState),
          highlight: false,
        },
      }));
    }, 5000);
  }, [setIsRunLogDialogOpen, updateNodeData]);


  const saveEditingFlow = useCallback(() => {
    if (!editingFlowId) return;
    setFlowNodeTypes(prevTypes => prevTypes.map(ft => {
      if (ft.id === editingFlowId) {
        ft.nodes = nodes.map((node) => toINode(node));
        ft.edges = edges.map(toIEdge).filter((edge): edge is IEdge => edge !== null);
      }
      return ft;
    }))
  }, [editingFlowId, setFlowNodeTypes, nodes, edges, toINode, toIEdge]);

  const handleEditFlow = useCallback((flowType: IFlowNodeType) => {
    setIsEditFlowDialogOpen(false);
    saveEditingFlow();
    setEditingFlowId(flowType.id);
    setNodes(flowType.nodes.map(fromIDSLNode));
    setEdges(flowType.edges.map(fromIDSLEdge));
  }, [setIsEditFlowDialogOpen, saveEditingFlow, setEditingFlowId, setNodes, setEdges, fromIDSLNode, fromIDSLEdge])

  // 新建Flow
  const handleNewFlow = useCallback(() => {
    // 保存当前的Flow
    saveEditingFlow();
    setNodes(initialNodes);
    setEdges(initialEdges);

    // 保证flow节点的id由flow_开头
    const newId = 'flow_' + generateId();
    const newName = `Flow ${flowNodeTypes.length + 1}`;
    const newDescription = `Custom flow type created on ${new Date().toLocaleString()}`;
    const flowNodeType = newFlowNodeType(newId, newName, newDescription, [], []);
    console.log('flowNodeType1', flowNodeType);
    setFlowNodeTypes(prevTypes => [...prevTypes, flowNodeType]);
    console.log('flowNodeType2', flowNodeType);
    setEditingFlowId(flowNodeType.id);

    // 自动弹出编辑窗口
    setEditingFlowInfoType(flowNodeType);
    setIsEditFlowDialogOpen(true);

    toast.info(`New flow type "${newName}" added.`);
  }, [saveEditingFlow, setNodes, setEdges, flowNodeTypes, setFlowNodeTypes, setEditingFlowInfoType, setIsEditFlowDialogOpen]);

  // 切换Flow
  const handleSwitchFlow = useCallback((flowType: IFlowNodeType) => {
    if (flowType.id === editingFlowId) {
      return;
    }
    // 1. 保存当前正在编辑的flow
    saveEditingFlow();

    // 2. 加载新flow的数据到画布上
    setNodes(flowType.nodes.map(fromIDSLNode));
    setEdges(flowType.edges.map(fromIDSLEdge));

    // 3. 更新当前正在编辑的flow的ID
    setEditingFlowId(flowType.id);

    // 4. 让视图适应新加载的节点
    setTimeout(() => fitView(), 50);

  }, [editingFlowId, saveEditingFlow, setNodes, setEdges, fromIDSLNode, fromIDSLEdge, setEditingFlowId, fitView]);



  return (
    <div className="w-full h-screen flex flex-row">
      <div className="flex flex-col min-w-64 max-w-64 h-auto shadow-lg rounded-r-lg">
        <div className='p-4 pb-0'>
          <div className="flex justify-between items-center mb-2">
            <div className="text-xl font-bold">ChatVisCode</div>
            <Button variant="outline" size="icon" onClick={() => setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light")}>
              {theme === "light" ? <Sun /> : theme === "dark" ? <Moon /> : <SunMoon />}
            </Button>
          </div>
          <div className='space-y-2'>
            <Button variant="outline" className="w-full" onClick={handleRun}>
              <PlayCircle />
              Run
            </Button>
            <Button variant="outline" className="w-full" onClick={() => onLayout('LR')}>
              <LayoutDashboard />
              Auto Layout
            </Button>
            <div className="flex flex-row gap-2">
              <Button variant="outline" className="flex-1" onClick={handleImportClick}>
                <FileDown />
                Import
              </Button>
              <Button variant="outline" className="flex-1" onClick={handleExport}>
                <FileUp />
                Export
              </Button>
            </div>
            <Button variant="outline" className="w-full" onClick={() => { setIsRunLogDialogOpen(true) }}>
              <ScrollText />
              Run Logs
            </Button>
            <Button variant="outline" className="w-full" onClick={handleOpenAICopilotDialog}>
              <Sparkles />
              AI Agent
            </Button>
            <Button variant="outline" className="w-full" onClick={handleNewFlow}>
              <Plus />
              New Flow
            </Button>
          </div>

          <Separator className="mt-2" />
        </div>

        <div className="p-4 overflow-y-auto">
          <div className="flex flex-col">
            <div className="text-lg font-bold">Nodes</div>
            <div className="text-sm text-muted-foreground">Drag and drop to add nodes</div>
            <Separator className="my-2" />
            <div className="space-y-2">
              {basicNodeTypes
                .map((nodeType) => (
                  <Button draggable className="w-full" key={nodeType.id}
                    onDragStart={(event) => event.dataTransfer.setData('application/reactflow', nodeType.id)}>
                    {nodeType.name}
                  </Button>
                ))}
            </div>

            <Separator className="my-2" />

            <div className="text-lg font-bold">Flows</div>
            <div className="text-sm text-muted-foreground">Drag and drop to add flows</div>
            <Separator className="my-2" />
            <div className="space-y-2">
              {flowNodeTypes
                .map((nodeType) => (
                  <div key={nodeType.id} className="flex items-center gap-1">
                    <Button
                      variant={editingFlowId === nodeType.id ? 'outline' : 'default'}
                      draggable
                      className="flex-1 min-w-0"
                      onDragStart={(event) => event.dataTransfer.setData('application/reactflow', nodeType.id)}
                      onClick={() => handleSwitchFlow(nodeType)}
                    >
                      <span className="truncate">{nodeType.name}</span>
                    </Button>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <EllipsisVertical />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem onClick={() => handleOpenEditFlowInfoDialog(nodeType)}>Edit Info</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleEditFlow(nodeType)}>Edit Flow</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleOpenDeleteFlowDialog(nodeType)}>Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypeUIMap as NodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onDrop={onDrop}
        onDragOver={onDragOver}
        colorMode={isDarkMode ? 'dark' : 'light'}
        defaultEdgeOptions={{ style: { strokeWidth: 3 }, animated: true }}
      >
        <Controls>
          <ControlButton onClick={() => onLayout('LR')} title="Auto Layout">
            <LayoutDashboard />
          </ControlButton>
        </Controls>
        <MiniMap />
        <Background variant={BackgroundVariant.Dots} />
      </ReactFlow>

      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        accept=".json"
        onChange={handleFileChange}
      />

      <EditInfoDialog
        isOpen={isEditFlowDialogOpen}
        onOpenChange={setIsEditFlowDialogOpen}
        title="Edit Flow"
        subtitle={`ID: ${editingFlowInfoType?.id}`}
        name={editingFlowInfoType?.name || ''}
        descriptionText={editingFlowInfoType?.description || ''}
        contextPrompt={editingFlowInfoType ? `Flow ID: ${editingFlowInfoType.id}
Flow Name: ${editingFlowInfoType.name}
Flow Description: ${editingFlowInfoType.description}
Flow DSL: ${JSON.stringify(dumpFlow(editingFlowInfoType))}` : undefined}
        onSave={handleSaveEditFlowInfo}
      />

      <AlertDialog open={isDeleteFlowDialogOpen} onOpenChange={setIsDeleteFlowDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the flow type
              <span className="font-semibold"> "{deletingFlowType?.name}"</span>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeletingFlowType(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDeleteFlow}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <LogDialog
        isLogDialogOpen={isRunLogDialogOpen}
        setIsLogDialogOpen={setIsRunLogDialogOpen}
        nodes={useMemo(() => nodes.map(node => toINode(node, true, false)), [nodes, toINode])}
        highlightNode={highlightNode}
      ></LogDialog>

      <AICopilotDialog
        isOpen={isAICopilotDialogOpen}
        onClose={() => setIsAICopilotDialogOpen(false)}
        DSL={useMemo(() => exportDSL(), [exportDSL])}
        setDSL={handleDSLUpdate}
        nodeTypeMap={nodeTypeMap}
        newFlowNodeType={newFlowNodeType}
        setNodeReviewed={setNodeReviewed}
      />

    </div >
  );
}

interface LogDialogProps {
  isLogDialogOpen: boolean
  setIsLogDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  nodes: INode[]
  highlightNode: (nodeId: string) => void
}

function LogDialog({ isLogDialogOpen, setIsLogDialogOpen, nodes, highlightNode }: LogDialogProps) {
  const [isShowAiPanel, setIsShowAiPanel] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiResponse, setAiResponse] = useState('');
  const [responseRef, setResponseRef] = useState<HTMLDivElement | null>(null);

  // 自动滚动到响应区域底部
  useEffect(() => {
    if (responseRef && isAiLoading) {
      responseRef.scrollTop = responseRef.scrollHeight;
    }
  }, [aiResponse, responseRef, isAiLoading]);

  const handleAiLogAnalysis = async () => {
    if (!prompt.trim()) return;
    setIsAiLoading(true);
    setAiResponse('');

    // 定义节点日志数据类型
    interface NodeLogData {
      id: string;
      type: string;
      typeName: string;
      name: string;
      runState: INodeStateRun<INodeInput, INodeOutput>;
      children?: NodeLogData[];
    }

    // 获取完整的日志数据，包括嵌套的Flow节点日志
    const extractFullLogData = (node: INode): NodeLogData => {
      const nodeData: NodeLogData = {
        id: node.id,
        type: node.type.id,
        typeName: node.type.name,
        name: node.config.name,
        runState: node.runState,
      };

      // 对过长的输入输出进行截断
      const MAX_LOG_IO_LENGTH = 1000;
      const truncate = (x: { [key: string]: unknown }) => {
        Object.entries(x).forEach(([key, value]) => {
          const jsonValue = JSON.stringify(value);
          if (jsonValue.length > MAX_LOG_IO_LENGTH) {
            x[key] = jsonValue.slice(0, MAX_LOG_IO_LENGTH) + '...[truncated]';
          }
        });
        return x;
      }
      nodeData.runState.input = truncate(nodeData.runState.input);
      nodeData.runState.output = truncate(nodeData.runState.output);
      nodeData.runState.logs = nodeData.runState.logs.map(log => ({
        ...log,
        input: log.input ? truncate(log.input) : log.input,
        output: log.output ? truncate(log.output) : log.output,
      }));

      // 如果是Flow节点，递归获取其子节点日志
      if (node.type.id.startsWith('flow_')) {
        const state = node.state as IFlowNodeState;
        if (state.runNodes && state.runNodes.length > 0) {
          nodeData.children = state.runNodes.map(childNode => extractFullLogData(childNode));
        }
      }

      return nodeData;
    };

    const fullLogData = JSON.stringify(nodes.map(node => extractFullLogData(node)), null, 2);

    const systemPrompt = `You are an expert log analysis assistant.
The user will provide you with logs from a flow execution and a question for analysis.
Analyze the logs based on the user's question and provide insights.
Think step by step and explain your analysis, You need to answer in the language of the user's question.

Current Logs:
\`\`\`json
${fullLogData}
\`\`\`
`;

    try {
      let fullResponse = '';

      const stream = llmStream(configGlobal.codeEditorModel, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ], []);

      for await (const chunk of stream) {
        fullResponse += chunk.content;
        setAiResponse(fullResponse);
      }

      if (!fullResponse) {
        toast.error('AI returned an empty response.');
        setAiResponse('AI returned an empty response.');
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error('Error during AI log analysis: ' + errorMessage);
      setAiResponse('Error during AI log analysis: ' + errorMessage);
    } finally {
      setIsAiLoading(false);
    }
  };

  return (
    <Dialog open={isLogDialogOpen} onOpenChange={setIsLogDialogOpen}>
      <DialogContent className="min-w-full min-h-full max-w-full max-h-full flex flex-col p-4 rounded-none">
        <DialogHeader className="shrink-0">
          <DialogTitle>Run Logs</DialogTitle>
          <div className="flex justify-between items-center">
            <DialogDescription>
              Timeline logs of recent flow run. You can also use the AI assistant to analyze logs.
            </DialogDescription>
            <Button variant="ghost" size="icon" onClick={() => setIsShowAiPanel(!isShowAiPanel)}>
              {isShowAiPanel ? <PanelRightClose /> : <PanelLeftClose />}
            </Button>
          </div>
        </DialogHeader>
        <div className="flex-1 flex flex-row gap-4 overflow-hidden min-h-0">
          <div className="flex-1 min-h-0 overflow-y-auto">
            <TimelineLog nodes={nodes} highlightNode={highlightNode} />
          </div>
          {isShowAiPanel && (
            <div className="w-1/3 flex flex-col gap-2">
              <div className="font-medium text-center">AI Log Analysis</div>
              <div
                ref={setResponseRef}
                className="flex-1 min-h-0 overflow-auto border rounded-md px-4 text-sm"
              >
                {aiResponse ? (
                  <MarkdownRenderer content={aiResponse} />
                ) : (
                  <div className="text-center text-muted-foreground">Ask AI to analyze logs...</div>
                )}
              </div>
              <Textarea
                placeholder={`Ask AI to analyze logs... (e.g., "Which nodes failed?", "Summarize the run.")`}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="resize-none text-sm h-24 shrink-0"
                disabled={isAiLoading}
              />
              <Button type="button" onClick={handleAiLogAnalysis} disabled={isAiLoading || !prompt.trim()}>
                {isAiLoading ? (
                  <>
                    <Loader className="animate-spin" /> Analyzing...
                  </>
                ) : (
                  `Analyze Logs`
                )}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default function FlowPage() {
  return (
    <ReactFlowProvider>
      <Flow />
    </ReactFlowProvider>
  );
}
