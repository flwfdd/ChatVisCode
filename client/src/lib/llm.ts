import { OpenAI } from "openai";
import config from "./config";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { FunctionParameters } from "openai/resources/shared.mjs";
import parseJson from 'json-parse-even-better-errors';

// 初始化OpenAI
const openai = new OpenAI({
    baseURL: config.llm.baseURL,
    apiKey: config.llm.apiKey,
    dangerouslyAllowBrowser: true,
});

// 自定义消息格式 - 模仿OpenAI但只保留必要字段
export interface Message {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
}

// 基础工具接口 - 不包含执行逻辑
export interface Tool<TArgs> {
    name: string;
    description: string;
    parameters: TArgs;
}

// 可执行工具接口 - 支持类型安全的参数解析
export interface ExecutableTool<TArgs> extends Tool<TArgs> {
    execute: (args: TArgs) => Promise<string>;
    parseArgs: (args: unknown) => TArgs;
}

// 使用 Zod Schema 创建类型安全的工具
export function createExecutableTool<TArgs>(
    name: string,
    description: string,
    schema: z.ZodSchema<TArgs>,
    execute: (args: TArgs) => Promise<string>
): ExecutableTool<TArgs> {
    return {
        name,
        description,
        parameters: zodToJsonSchema(schema, { $refStrategy: 'none' }) as TArgs,
        execute: async (args: TArgs) => {
            const parsedArgs = schema.parse(args);
            return execute(parsedArgs);
        },
        parseArgs: (args: unknown) => schema.parse(args) as TArgs
    };
}

// 类型安全的工具调用处理
export function createToolCallHandler<TArgs>(
    tool: ExecutableTool<TArgs>
): (args: unknown) => Promise<string> {
    return async (args: unknown) => {
        const parsedArgs = tool.parseArgs(args) ?? args as TArgs;
        return tool.execute(parsedArgs);
    };
}

// 工具调用类型
export interface ToolCall {
    id: string;
    name: string;
    arguments: string;
}

export interface StartParams {
    model: string;
    messages: Message[];
    tools?: Tool<unknown>[];
}

export interface Chunk {
    content?: string;
    tool_calls?: Array<{
        index: number;
        id?: string;
        function?: {
            name?: string;
            arguments?: string;
        };
    }>;
}

// React 事件类型 - 使用自定义格式
export type ReactEvent =
    | { type: "llm_start"; params: StartParams }
    | { type: "llm_chunk"; chunk: Chunk }
    | { type: "llm_end"; message: Message }
    | { type: "tool_start"; tool_call: ToolCall }
    | { type: "tool_end"; message: Message }
    | { type: "end"; messages: Message[] };

// 转换函数：OpenAI格式 -> 自定义格式
function fromOpenAIMessage(openaiMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam): Message {
    if (openaiMessage.role === 'assistant') {
        return {
            role: 'assistant',
            content: typeof openaiMessage.content === 'string' ? openaiMessage.content : null,
            tool_calls: openaiMessage.tool_calls?.map(tc => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments
            }))
        };
    } else if (openaiMessage.role === 'tool') {
        return {
            role: 'tool',
            content: typeof openaiMessage.content === 'string' ? openaiMessage.content : null,
            tool_call_id: openaiMessage.tool_call_id
        };
    } else {
        return {
            role: openaiMessage.role as 'system' | 'user',
            content: typeof openaiMessage.content === 'string' ? openaiMessage.content : null,
        };
    }
}

// 转换函数：自定义格式 -> OpenAI格式
function toOpenAITool(tool: Tool<unknown>): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
        type: "function" as const,
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as FunctionParameters
        }
    };
}

function toOpenAIMessage(message: Message): OpenAI.Chat.Completions.ChatCompletionMessageParam {
    if (message.role === 'assistant') {
        return {
            role: 'assistant',
            content: message.content || ' ',
            tool_calls: message.tool_calls?.map(tc => ({
                id: tc.id,
                type: 'function',
                function: {
                    name: tc.name,
                    arguments: tc.arguments
                }
            }))
        };
    } else if (message.role === 'tool') {
        return {
            role: 'tool',
            content: message.content || ' ',
            tool_call_id: message.tool_call_id!
        };
    } else {
        return {
            role: message.role as 'system' | 'user',
            content: message.content || ' ',
        };
    }
}

// 支持工具调用的 LLM 函数（单次调用）
export async function llm(
    model: string,
    messages: Message[],
    tools: Tool<unknown>[]
): Promise<Message> {
    const openaiMessages = messages.map(toOpenAIMessage);

    // 将工具转换为 OpenAI 格式
    const openaiTools = tools.map(toOpenAITool);

    const response = await openai.chat.completions.create({
        model,
        messages: openaiMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
    });

    const message = response.choices[0].message;
    return fromOpenAIMessage(message);
}

// 流式 LLM 调用
export async function* llmStream(
    model: string,
    messages: Message[],
    tools: Tool<unknown>[]
): AsyncGenerator<Chunk, void, unknown> {
    const openaiMessages = messages.map(toOpenAIMessage);
    const openaiTools = tools.map(toOpenAITool);
    const stream = await openai.chat.completions.create({
        model,
        messages: openaiMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        stream: true,
    });

    for await (const chunk of stream) {
        yield chunk.choices[0]?.delta as Chunk;
    }
}

// React 模式 - 支持工具调用（通过 reactStream 实现）
export async function* react(
    model: string,
    messages: Message[],
    tools: ExecutableTool<Record<string, unknown>>[],
    maxIterations: number = 10
): AsyncGenerator<ReactEvent, void, unknown> {
    for await (const event of reactStream(model, messages, tools, maxIterations)) {
        // 过滤掉 llm_chunk 事件，只保留其他事件
        if (event.type !== "llm_chunk") {
            yield event;
        }
    }
}

// React 流式模式 - 支持工具调用和流式输出
export async function* reactStream(
    model: string,
    messages: Message[],
    tools: ExecutableTool<Record<string, unknown>>[],
    maxIterations: number = 10
): AsyncGenerator<ReactEvent, void, unknown> {
    const conversationMessages = [...messages];
    const allMessages: Message[] = [];
    let iteration = 0;

    // 将工具转换为 OpenAI 格式
    const openaiTools = tools.map(toOpenAITool);

    // 创建工具名称到工具对象的映射
    const toolMap = new Map(tools.map(tool => [tool.name, tool]));

    while (iteration < maxIterations) {
        iteration++;

        // 转换消息为OpenAI格式
        const openaiMessages = conversationMessages.map(toOpenAIMessage);

        // 流式调用模型参数
        const params: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
            model,
            messages: openaiMessages,
            tools: openaiTools.length > 0 ? openaiTools : undefined,
            stream: true,
        };

        // 发出 LLM 开始事件
        yield {
            type: "llm_start",
            params: {
                model,
                messages: conversationMessages,
                tools: tools
            }
        };

        const stream = await openai.chat.completions.create(params);

        const assistantMessage: Message = {
            role: "assistant",
            content: "",
            tool_calls: []
        };

        let currentToolCall: Partial<ToolCall> | null = null;
        let toolCallIndex = -1;

        for await (const chunk of stream) {
            // 发出 LLM chunk 事件
            const chunkEvent: Chunk = {};
            const delta = chunk.choices[0]?.delta;

            if (delta?.content) {
                chunkEvent.content = delta.content;
                assistantMessage.content += delta.content;
            }

            if (delta?.tool_calls) {
                chunkEvent.tool_calls = delta.tool_calls;
                for (const toolCallDelta of delta.tool_calls) {
                    if (toolCallDelta.index !== undefined) {
                        if (toolCallDelta.index !== toolCallIndex) {
                            // 新的工具调用
                            if (currentToolCall && currentToolCall.id) {
                                assistantMessage.tool_calls?.push(currentToolCall as ToolCall);
                            }
                            toolCallIndex = toolCallDelta.index;
                            currentToolCall = {
                                id: toolCallDelta.id || "",
                                name: "",
                                arguments: ""
                            };
                        }

                        if (toolCallDelta.id) {
                            currentToolCall!.id = toolCallDelta.id;
                        }

                        if (toolCallDelta.function?.name) {
                            currentToolCall!.name += toolCallDelta.function.name;
                        }

                        if (toolCallDelta.function?.arguments) {
                            currentToolCall!.arguments += toolCallDelta.function.arguments;
                        }
                    }
                }
            }

            yield { type: "llm_chunk", chunk: chunkEvent };
        }

        // 添加最后一个工具调用
        if (currentToolCall && currentToolCall.id) {
            assistantMessage.tool_calls?.push(currentToolCall as ToolCall);
        }

        // 清理空的 tool_calls 数组
        if (assistantMessage.tool_calls?.length === 0) {
            delete assistantMessage.tool_calls;
        }

        allMessages.push(assistantMessage);

        // 发出 LLM 结束事件
        yield { type: "llm_end", message: assistantMessage };

        // 如果没有工具调用，结束循环
        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
            yield {
                type: "end",
                messages: allMessages
            };
            break;
        }

        // 添加助手消息到对话
        conversationMessages.push(assistantMessage);

        // 执行工具调用
        for (const toolCall of assistantMessage.tool_calls) {
            // 发出工具开始事件
            yield { type: "tool_start", tool_call: toolCall };

            try {
                const tool = toolMap.get(toolCall.name);
                if (!tool) {
                    throw new Error(`Unknown tool: ${toolCall.name}`);
                }

                const args = parseJson(toolCall.arguments);

                // 使用类型安全的工具调用处理
                const handler = createToolCallHandler(tool);
                const result = await handler(args);

                const toolMessage: Message = {
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: result,
                };

                allMessages.push(toolMessage);

                // 发出工具结束事件
                yield { type: "tool_end", message: toolMessage };

                // 添加工具结果到对话
                conversationMessages.push(toolMessage);
            } catch (error) {
                const errorMessage: Message = {
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: `Error executing tool: ${error}`,
                };

                allMessages.push(errorMessage);

                // 发出工具结束事件（包含错误）
                yield { type: "tool_end", message: errorMessage };

                conversationMessages.push(errorMessage);
            }
        }
    }

    if (iteration >= maxIterations) {
        yield {
            type: "end",
            messages: allMessages
        };
    }
}