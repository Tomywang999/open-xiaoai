import { type EngineConfig, MiGPTEngine } from "@mi-gpt/engine";
import { deepMerge } from "@mi-gpt/utils";
import { jsonDecode } from "@mi-gpt/utils/parse";
import type { Prettify } from "@mi-gpt/utils/typing";
import { RustServer } from "./open-xiaoai.js";
import { OpenXiaoAISpeaker } from "./speaker.js";
import { randomUUID } from "node:crypto";

export type OpenXiaoAIConfig = Prettify<EngineConfig<OpenXiaoAIEngine>>;

const kDefaultOpenXiaoAIConfig: OpenXiaoAIConfig = {
  //
};

/**
 * Remove thinking tags from text
 * This cleans <think> and </think> tags from OpenAI API responses
 * including multi-line cases where tags might have line breaks
 */
function removeThinkingTags(text: string): string {
  // First remove individual tags
  let result = text.replace(/<think>|<\/think>/g, "");
  
  // Handle multi-line think tags with content between them
  result = result.replace(/<think>\s*\n([\s\S]*?)\n\s*<\/think>/g, "");
  
  // Final cleanup to catch any remaining think blocks with or without line breaks
  result = result.replace(/<think>[\s\S]*?<\/think>/g, "");
  
  return result;
}

class OpenXiaoAIEngine extends MiGPTEngine {
  speaker = OpenXiaoAISpeaker;

  async start(config: OpenXiaoAIConfig) {
    await super.start(deepMerge(kDefaultOpenXiaoAIConfig, config));
    // 注册全局回调函数
    (global as any).RUST_CALLBACKS = {
      on_event: this.onEvent,
      on_input_data: this.onRecord,
    };
    // 启动服务
    console.log("✅ 服务已启动...");
    await RustServer.start();
  }

  /**
   * Process AI response to remove thinking tags
   * Override the parent class method to clean the response
   */
  protected override async processAIResponse(response: string): Promise<string> {
    // First run the parent implementation if there is any
    const processedResponse = await super.processAIResponse?.(response) || response;
    // Then remove thinking tags from the processed response
    return removeThinkingTags(processedResponse);
  }

  /**
   * 收到事件
   */
  onEvent = (event: string) => {
    const e = JSON.parse(event);
    if (e.event === "playing") {
      // 更新播放状态
      OpenXiaoAISpeaker.status =
        e.data === "Playing"
          ? "playing"
          : e.data === "Paused"
          ? "paused"
          : "idle";
    } else if (e.event === "instruction" && e.data.NewLine) {
      // 收到语音识别结果
      const line = jsonDecode(e.data.NewLine);
      if (
        line?.header?.namespace === "SpeechRecognizer" &&
        line?.header?.name === "RecognizeResult" &&
        line?.payload?.is_final &&
        line?.payload?.results?.[0]?.text
      ) {
        const text = line.payload.results[0].text;
        this.onMessage({
          text,
          id: randomUUID(),
          sender: "user",
          timestamp: Date.now(),
        });
      }
    } else if (e.event === "kws") {
      const keyword = e.data;
      console.log("🔥 唤醒词识别", keyword);
    }
  };

  /**
   * 收到录音音频流
   */
  onRecord = (data: Uint8Array) => {
    console.log("🔥 收到录音音频流", data.length);
  };
}

export const OpenXiaoAI = new OpenXiaoAIEngine();
