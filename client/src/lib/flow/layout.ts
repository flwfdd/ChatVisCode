import dagre from 'dagre';
import { Edge, Node, Position } from '@xyflow/react';

export interface LayoutOptions {
    direction?: 'TB' | 'LR';
}

/**
 * 自动布局算法
 * @param nodes 
 * @param edges 
 * @param options 
 * @returns 
 */
export const getLayoutedElements = (nodes: Node[], edges: Edge[], options: LayoutOptions = {}) => {
    const { direction = 'LR' } = options;
    const isHorizontal = direction === 'LR';

    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setDefaultEdgeLabel(() => ({}));

    // 设置布局方向
    dagreGraph.setGraph({ rankdir: direction });

    // 1. 设置节点大小
    nodes.forEach((node) => {
        // React Flow v12 中，节点可能有 measured 属性包含宽高
        // 如果没有，使用默认值 (例如 150x50)
        const width = node.measured?.width ?? 150;
        const height = node.measured?.height ?? 50;

        dagreGraph.setNode(node.id, { width, height });
    });

    // 2. 设置边
    edges.forEach((edge) => {
        dagreGraph.setEdge(edge.source, edge.target);
    });

    // 3. 计算布局
    dagre.layout(dagreGraph);

    // 4. 应用计算出的位置
    const layoutedNodes = nodes.map((node) => {
        const nodeWithPosition = dagreGraph.node(node.id);

        // dagre 返回的是节点的中心点，React Flow 使用左上角
        const width = node.measured?.width ?? 150;
        const height = node.measured?.height ?? 50;

        return {
            ...node,
            targetPosition: isHorizontal ? Position.Left : Position.Top,
            sourcePosition: isHorizontal ? Position.Right : Position.Bottom,
            position: {
                x: nodeWithPosition.x - width / 2,
                y: nodeWithPosition.y - height / 2,
            },
        };
    });

    return { nodes: layoutedNodes, edges };
};
