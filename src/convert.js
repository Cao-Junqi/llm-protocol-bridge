export function anthropicToChat(body) {
  const messages = [];
  if (body.system) messages.push({ role: "system", content: systemText(body.system) });
  for (const message of body.messages || []) messages.push(...anthropicMessageToChat(message));

  return clean({
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream,
    tools: anthropicToolsToOpenAI(body.tools),
    tool_choice: anthropicToolChoiceToOpenAI(body.tool_choice),
  });
}

export function chatToAnthropic(body) {
  const messages = [];
  let system;

  for (const message of body.messages || []) {
    if (message.role === "system") {
      system = appendText(system, message.content);
      continue;
    }
    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content || "" }],
      });
      continue;
    }
    messages.push(chatMessageToAnthropic(message));
  }

  return clean({
    model: body.model,
    messages,
    system,
    max_tokens: body.max_tokens || body.max_completion_tokens || 4096,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream,
    tools: openAIToolsToAnthropic(body.tools),
    tool_choice: openAIToolChoiceToAnthropic(body.tool_choice),
  });
}

export function responsesToChat(body) {
  return clean({
    model: body.model,
    messages: responsesInputToChatMessages(body.input),
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream,
    tools: responsesToolsToChat(body.tools),
    tool_choice: body.tool_choice,
  });
}

export function chatToResponses(body) {
  return clean({
    model: body.model,
    input: chatMessagesToResponsesInput(body.messages),
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream,
    tools: chatToolsToResponses(body.tools),
    tool_choice: body.tool_choice,
    reasoning: body.reasoning,
  });
}

export function anthropicToResponses(body) {
  return clean({
    model: body.model,
    input: anthropicMessagesToResponsesInput(body),
    max_output_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream,
    tools: anthropicToolsToResponses(body.tools),
    tool_choice: anthropicToolChoiceToOpenAI(body.tool_choice),
    reasoning: body.thinking ? { effort: body.thinking.budget_tokens ? "high" : undefined } : undefined,
  });
}

export function responsesToAnthropic(body) {
  const converted = chatToAnthropic(responsesToChat(body));
  converted.max_tokens = body.max_output_tokens || converted.max_tokens;
  return converted;
}

export function chatToAnthropicResponse(chat, model) {
  const choice = chat.choices?.[0] || {};
  return anthropicResponse({
    id: chat.id,
    model: chat.model || model,
    content: chatMessageContentToAnthropic(choice.message || {}),
    stop_reason: stopReason(choice.finish_reason),
    usage: {
      input_tokens: chat.usage?.prompt_tokens || 0,
      output_tokens: chat.usage?.completion_tokens || 0,
    },
  });
}

export function anthropicToChatResponse(body, model) {
  const message = { role: "assistant", content: "" };
  const contentParts = [];
  const toolCalls = [];

  for (const block of body.content || []) {
    if (block.type === "text") message.content += block.text || "";
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      });
    } else contentParts.push(anthropicBlockToChatPart(block));
  }

  if (!message.content && contentParts.length) message.content = contentParts;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: body.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || model,
    choices: [{ index: 0, message, finish_reason: body.stop_reason === "tool_use" ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: body.usage?.input_tokens || 0,
      completion_tokens: body.usage?.output_tokens || 0,
      total_tokens: (body.usage?.input_tokens || 0) + (body.usage?.output_tokens || 0),
    },
  };
}

export function responsesToAnthropicResponse(body, model) {
  const content = [];

  for (const item of body.output || []) {
    if (item.type === "message") {
      for (const part of item.content || []) content.push(responseContentToAnthropic(part));
    } else if (item.type === "function_call") {
      content.push({
        type: "tool_use",
        id: item.call_id || item.id,
        name: item.name,
        input: parseJson(item.arguments || "{}") || {},
      });
    } else if (item.type === "reasoning") {
      content.push({ type: "thinking", thinking: item.summary?.map((s) => s.text).join("\n") || item.content || "" });
    } else if (item.type === "computer_call") {
      content.push({ type: "tool_use", id: item.call_id || item.id, name: "computer", input: clean({ action: item.action, pending_safety_checks: item.pending_safety_checks }) });
    } else content.push({ type: "text", text: jsonFence(item) });
  }

  return anthropicResponse({
    id: body.id,
    model: body.model || model,
    content,
    stop_reason: body.status === "incomplete" ? "max_tokens" : "end_turn",
    usage: {
      input_tokens: body.usage?.input_tokens || 0,
      output_tokens: body.usage?.output_tokens || 0,
    },
  });
}

export function anthropicToResponsesResponse(body, model) {
  const output = [];
  for (const block of body.content || []) {
    if (block.type === "tool_use") {
      output.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) });
    } else if (block.type === "thinking") {
      output.push({ type: "reasoning", summary: [{ type: "summary_text", text: block.thinking || "" }] });
    } else {
      output.push({ type: "message", role: "assistant", content: [anthropicBlockToResponseContent(block, "output")] });
    }
  }

  return {
    id: body.id || `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: body.model || model,
    output,
    status: "completed",
    usage: {
      input_tokens: body.usage?.input_tokens || 0,
      output_tokens: body.usage?.output_tokens || 0,
      total_tokens: (body.usage?.input_tokens || 0) + (body.usage?.output_tokens || 0),
    },
  };
}

export function chatToResponsesResponse(chat, model) {
  const choice = chat.choices?.[0] || {};
  const output = [];
  const message = choice.message || {};

  if (message.content) {
    output.push({ type: "message", role: "assistant", content: chatContentToResponsesContent(message.content, "output") });
  }
  for (const call of message.tool_calls || []) {
    output.push({ type: "function_call", call_id: call.id, name: call.function?.name, arguments: call.function?.arguments || "{}" });
  }

  return {
    id: chat.id || `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: chat.model || model,
    output,
    status: "completed",
    usage: {
      input_tokens: chat.usage?.prompt_tokens || 0,
      output_tokens: chat.usage?.completion_tokens || 0,
      total_tokens: chat.usage?.total_tokens || 0,
    },
  };
}

export function responsesToChatResponse(body, model) {
  const message = { role: "assistant", content: "" };
  const content = [];
  const toolCalls = [];

  for (const item of body.output || []) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        const converted = responseContentToChatPart(part);
        if (typeof converted === "string") message.content += converted;
        else content.push(converted);
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id,
        type: "function",
        function: { name: item.name, arguments: item.arguments || "{}" },
      });
    } else if (item.type === "reasoning") {
      message.reasoning_content = item.summary?.map((s) => s.text).join("\n") || item.content || "";
    } else content.push({ type: "text", text: jsonFence(item) });
  }

  if (!message.content && content.length) message.content = content;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: body.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: body.usage?.input_tokens || 0,
      completion_tokens: body.usage?.output_tokens || 0,
      total_tokens: body.usage?.total_tokens || 0,
    },
  };
}

export function normalizeResponseInput(body) {
  if (body.input !== undefined) return body;
  if (body.messages) return chatToResponses(body);
  return body;
}

export function shouldFallback(status, body) {
  if ([400, 404, 422].includes(status)) return true;
  const message = JSON.stringify(body?.error || body || "").toLowerCase();
  return /unsupported|not support|not found|unknown endpoint|invalid.*endpoint|model.*not.*support/.test(message);
}

export function anthropicSseToChatSse(chunk) {
  return parseSse(chunk).flatMap(({ data }) => {
    if (data === "[DONE]") return ["data: [DONE]\n\n"];
    const event = parseJson(data);
    if (!event) return [];
    return anthropicEventToChatChunk(event).map((item) => `data: ${JSON.stringify(item)}\n\n`);
  }).join("");
}

export function chatSseToAnthropicSse(chunk, model) {
  return parseSse(chunk).flatMap(({ data }) => {
    if (data === "[DONE]") return [
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } }),
      sse("message_stop", { type: "message_stop" }),
    ];
    const parsed = parseJson(data);
    const delta = parsed?.choices?.[0]?.delta || {};
    if (delta.role === "assistant") return [anthropicMessageStart(parsed, model)];
    if (delta.content) return [anthropicTextDelta(delta.content)];
    if (delta.tool_calls) return delta.tool_calls.map((call, index) => sse("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: call.function?.arguments || "" },
    }));
    if (delta.reasoning_content) return [anthropicThinkingDelta(delta.reasoning_content)];
    return [];
  }).join("");
}

export function responsesSseToAnthropicSse(chunk, model) {
  return parseSse(chunk).flatMap(({ event, data }) => {
    const parsed = parseJson(data);
    if (!parsed) return [];
    if (event?.includes("created") || parsed.type?.includes("created")) return [anthropicMessageStart(parsed.response || parsed, model)];
    if (event?.includes("output_text.delta") || parsed.type === "response.output_text.delta") return [anthropicTextDelta(parsed.delta || "")];
    if (event?.includes("function_call_arguments.delta")) return [sse("content_block_delta", {
      type: "content_block_delta",
      index: parsed.output_index || 0,
      delta: { type: "input_json_delta", partial_json: parsed.delta || "" },
    })];
    if (event?.includes("reasoning") && parsed.delta) return [anthropicThinkingDelta(parsed.delta)];
    if (event?.includes("completed") || parsed.type === "response.completed") return [sse("message_stop", { type: "message_stop" })];
    return [];
  }).join("");
}

export function responsesSseToChatSse(chunk) {
  return parseSse(chunk).flatMap(({ event, data }) => {
    const parsed = parseJson(data);
    if (!parsed) return [];
    if (event?.includes("created") || parsed.type?.includes("created")) {
      const response = parsed.response || parsed;
      return [`data: ${JSON.stringify({ id: response.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: response.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`];
    }
    if (event?.includes("output_text.delta") || parsed.type === "response.output_text.delta") {
      return [`data: ${JSON.stringify({ choices: [{ index: parsed.output_index || 0, delta: { content: parsed.delta || "" }, finish_reason: null }] })}\n\n`];
    }
    if (event?.includes("completed") || parsed.type === "response.completed") return ["data: [DONE]\n\n"];
    return [];
  }).join("");
}

function anthropicMessageToChat(message) {
  if (!Array.isArray(message.content)) return [{ role: message.role, content: message.content || "" }];

  const out = [];
  const content = [];
  const toolCalls = [];
  for (const block of message.content) {
    if (block.type === "tool_result") {
      out.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: stringifyBlockContent(block.content),
      });
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      });
    } else content.push(anthropicBlockToChatPart(block));
  }

  if (content.length || toolCalls.length) {
    out.unshift(clean({
      role: message.role,
      content: content.length === 1 && content[0].type === "text" ? content[0].text : content,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    }));
  }
  return out;
}

function chatMessageToAnthropic(message) {
  return clean({
    role: message.role,
    content: [
      ...chatContentToAnthropic(message.content),
      ...(message.reasoning_content ? [{ type: "thinking", thinking: message.reasoning_content }] : []),
      ...(message.tool_calls || []).map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.function?.name,
        input: parseJson(call.function?.arguments || "{}") || {},
      })),
    ],
  });
}

function chatMessageContentToAnthropic(message) {
  return [
    ...chatContentToAnthropic(message.content),
    ...(message.reasoning_content ? [{ type: "thinking", thinking: message.reasoning_content }] : []),
    ...(message.tool_calls || []).map((call) => ({
      type: "tool_use",
      id: call.id,
      name: call.function?.name,
      input: parseJson(call.function?.arguments || "{}") || {},
    })),
  ];
}

function anthropicMessagesToResponsesInput(body) {
  const input = [];
  if (body.system) input.push({ role: "system", content: [{ type: "input_text", text: systemText(body.system) }] });
  for (const message of body.messages || []) {
    if (!Array.isArray(message.content)) {
      input.push({ role: message.role, content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content || "" }] });
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_result") input.push({ type: "function_call_output", call_id: block.tool_use_id, output: stringifyBlockContent(block.content) });
      else if (block.type === "tool_use") input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) });
      else input.push({ role: message.role, content: [anthropicBlockToResponseContent(block, message.role === "assistant" ? "output" : "input")] });
    }
  }
  return input;
}

function chatMessagesToResponsesInput(messages = []) {
  const input = [];
  for (const message of messages) {
    if (message.role === "tool") input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content || "" });
    else {
      input.push({
        role: message.role,
        content: chatContentToResponsesContent(message.content, message.role === "assistant" ? "output" : "input"),
      });
      for (const call of message.tool_calls || []) {
        input.push({ type: "function_call", call_id: call.id, name: call.function?.name, arguments: call.function?.arguments || "{}" });
      }
    }
  }
  return input;
}

function responsesInputToChatMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const messages = [];
  for (const item of input || []) {
    if (item.type === "function_call_output") messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output || "" });
    else if (item.type === "function_call") {
      messages.push({ role: "assistant", content: "", tool_calls: [{ id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } }] });
    } else if (item.type === "message" || item.role) {
      messages.push({ role: item.role || "user", content: responseContentArrayToChat(item.content) });
    } else if (item.type === "computer_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: JSON.stringify(item.output || item) });
    } else messages.push({ role: "user", content: jsonFence(item) });
  }
  return messages;
}

function anthropicBlockToChatPart(block) {
  if (block.type === "text") return { type: "text", text: block.text || "" };
  if (block.type === "image") return { type: "image_url", image_url: { url: imageSourceToUrl(block.source) } };
  if (block.type === "thinking") return { type: "text", text: `<thinking>${block.thinking || ""}</thinking>` };
  if (block.type === "redacted_thinking") return { type: "text", text: `<redacted_thinking>${block.data || ""}</redacted_thinking>` };
  return { type: "text", text: jsonFence(block) };
}

function anthropicBlockToResponseContent(block, direction) {
  const textType = direction === "output" ? "output_text" : "input_text";
  if (block.type === "text") return { type: textType, text: block.text || "" };
  if (block.type === "image") return { type: "input_image", image_url: imageSourceToUrl(block.source) };
  if (block.type === "thinking") return { type: textType, text: `<thinking>${block.thinking || ""}</thinking>` };
  if (block.type === "redacted_thinking") return { type: textType, text: `<redacted_thinking>${block.data || ""}</redacted_thinking>` };
  return { type: textType, text: jsonFence(block) };
}

function responseContentToAnthropic(part) {
  if (part.type === "output_text" || part.type === "input_text" || part.type === "text") return { type: "text", text: part.text || "" };
  if (part.type === "input_image") return openAIImageToAnthropic(part.image_url || part.image);
  if (part.type === "input_file") return { type: "text", text: jsonFence(part) };
  if (part.type?.includes("audio")) return { type: "text", text: jsonFence(part) };
  return { type: "text", text: jsonFence(part) };
}

function responseContentToChatPart(part) {
  if (part.type === "output_text" || part.type === "input_text" || part.type === "text") return part.text || "";
  if (part.type === "input_image") return { type: "image_url", image_url: { url: part.image_url } };
  if (part.type?.includes("audio")) return { type: "input_audio", input_audio: part.input_audio || part.audio };
  return { type: "text", text: jsonFence(part) };
}

function chatContentToAnthropic(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return (content || []).map((part) => {
    if (part.type === "text") return { type: "text", text: part.text || "" };
    if (part.type === "image_url") return openAIImageToAnthropic(part.image_url?.url);
    if (part.type === "input_audio") return { type: "text", text: jsonFence(part) };
    if (part.type === "file") return { type: "text", text: jsonFence(part) };
    return { type: "text", text: jsonFence(part) };
  });
}

function chatContentToResponsesContent(content, direction) {
  const textType = direction === "output" ? "output_text" : "input_text";
  if (typeof content === "string") return [{ type: textType, text: content }];
  return (content || []).map((part) => {
    if (part.type === "text") return { type: textType, text: part.text || "" };
    if (part.type === "image_url") return { type: "input_image", image_url: part.image_url?.url };
    if (part.type === "input_audio") return { type: "input_audio", input_audio: part.input_audio };
    if (part.type === "file") return { type: "input_file", file_id: part.file?.file_id, filename: part.file?.filename, file_data: part.file?.file_data };
    return { type: textType, text: jsonFence(part) };
  });
}

function responseContentArrayToChat(content) {
  const parts = (content || []).map(responseContentToChatPart);
  const text = parts.filter((part) => typeof part === "string").join("");
  const rich = parts.filter((part) => typeof part !== "string");
  if (!rich.length) return text;
  return [...(text ? [{ type: "text", text }] : []), ...rich];
}

function anthropicToolsToOpenAI(tools) {
  if (!tools) return undefined;
  return tools.map((tool) => tool.type && tool.type !== "custom"
    ? { ...tool, function: tool.function }
    : { type: "function", function: { name: tool.name, description: tool.description || "", parameters: tool.input_schema || { type: "object", properties: {} } } });
}

function openAIToolsToAnthropic(tools) {
  if (!tools) return undefined;
  return tools.map((tool) => tool.type === "function"
    ? { name: tool.function?.name, description: tool.function?.description || "", input_schema: tool.function?.parameters || { type: "object", properties: {} } }
    : tool);
}

function anthropicToolsToResponses(tools) {
  if (!tools) return undefined;
  return tools.map((tool) => tool.type && tool.type !== "custom"
    ? tool
    : { type: "function", name: tool.name, description: tool.description || "", parameters: tool.input_schema || { type: "object", properties: {} } });
}

function responsesToolsToChat(tools) {
  if (!tools) return undefined;
  return tools.map((tool) => tool.type === "function"
    ? { type: "function", function: { name: tool.name, description: tool.description || "", parameters: tool.parameters || { type: "object", properties: {} } } }
    : tool);
}

function chatToolsToResponses(tools) {
  if (!tools) return undefined;
  return tools.map((tool) => tool.type === "function"
    ? { type: "function", name: tool.function?.name, description: tool.function?.description || "", parameters: tool.function?.parameters || { type: "object", properties: {} } }
    : tool);
}

function anthropicToolChoiceToOpenAI(choice) {
  if (!choice) return undefined;
  if (choice.type === "auto" || choice.type === "any") return choice.type === "any" ? "required" : "auto";
  if (choice.type === "tool") return { type: "function", function: { name: choice.name } };
  return choice;
}

function openAIToolChoiceToAnthropic(choice) {
  if (!choice) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice.type === "function") return { type: "tool", name: choice.function?.name };
  return choice;
}

function anthropicResponse({ id, model, content, stop_reason, usage }) {
  return {
    id: id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage,
  };
}

function anthropicEventToChatChunk(event) {
  if (event.type === "message_start") return [{ id: event.message?.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: event.message?.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }];
  if (event.type === "content_block_delta" && event.delta?.text) return [{ object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), choices: [{ index: event.index || 0, delta: { content: event.delta.text }, finish_reason: null }] }];
  if (event.type === "content_block_delta" && event.delta?.thinking) return [{ object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), choices: [{ index: event.index || 0, delta: { reasoning_content: event.delta.thinking }, finish_reason: null }] }];
  if (event.type === "content_block_delta" && event.delta?.partial_json) return [{ object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), choices: [{ index: event.index || 0, delta: { tool_calls: [{ index: event.index || 0, function: { arguments: event.delta.partial_json } }] }, finish_reason: null }] }];
  if (event.type === "message_stop") return [{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
  return [];
}

function parseSse(chunk) {
  return chunk.split("\n\n").map((event) => event.trim()).filter(Boolean).map((raw) => {
    const lines = raw.split("\n");
    return {
      event: lines.find((line) => line.startsWith("event: "))?.slice(7),
      data: lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n"),
    };
  });
}

function anthropicMessageStart(parsed, model) {
  return sse("message_start", {
    type: "message_start",
    message: { id: parsed.id || `msg_${Date.now()}`, type: "message", role: "assistant", model: parsed.model || model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });
}

function anthropicTextDelta(text) {
  return sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
}

function anthropicThinkingDelta(thinking) {
  return sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } });
}

function imageSourceToUrl(source = {}) {
  if (typeof source === "string") return source;
  if (source.type === "url") return source.url;
  if (source.type === "base64") return `data:${source.media_type || "image/png"};base64,${source.data}`;
  return source.url || source.image_url || "";
}

function openAIImageToAnthropic(value) {
  const url = typeof value === "string" ? value : value?.url;
  if (url?.startsWith("data:")) {
    const [, media_type, data] = url.match(/^data:([^;]+);base64,(.*)$/) || [];
    return { type: "image", source: { type: "base64", media_type: media_type || "image/png", data: data || "" } };
  }
  return { type: "image", source: { type: "url", url } };
}

function stringifyBlockContent(content) {
  if (typeof content === "string") return content;
  return JSON.stringify(content || "");
}

function systemText(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((block) => block.text || "").filter(Boolean).join("\n");
  return "";
}

function stopReason(reason) {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop") return "end_turn";
  return reason || "end_turn";
}

function appendText(current, content) {
  const text = typeof content === "string" ? content : JSON.stringify(content || "");
  return current ? `${current}\n${text}` : text;
}

function jsonFence(value) {
  return `\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function clean(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
