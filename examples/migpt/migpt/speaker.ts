import { jsonEncode } from "@mi-gpt/utils/parse";
import { RustServer } from "./open-xiaoai.js";
import type { ISpeaker } from "@mi-gpt/engine/base";

/**
 * Remove all thinking tags from text
 * This comprehensively cleans <think> and </think> tags from text responses
 */
function removeThinkingTags(text: string): string {
  if (!text) return text;
  
  // Remove simple tags
  let result = text.replace(/<think>|<\/think>/g, "");
  
  // Remove tags with content between them (including multi-line)
  result = result.replace(/<think>[\s\S]*?<\/think>/g, "");
  
  return result;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

class SpeakerManager implements ISpeaker {
  /**
   * Current speaker status
   */
  status: "idle" | "playing" | "paused" = "idle";

  /**
   * 获取播放状态
   */
  async getPlaying(sync = false) {
    if (sync) {
      // 同步远端最新状态
      const res = await this.runShell("mphelper mute_stat");
      if (res?.stdout.includes("1")) {
        this.status = "playing";
      } else if (res?.stdout.includes("2")) {
        this.status = "paused";
      }
    }
    return this.status;
  }

  /**
   * 播放/暂停
   */
  async setPlaying(playing = true) {
    const res = await this.runShell(
      playing ? "mphelper play" : "mphelper pause"
    );
    return res?.stdout.includes('"code": 0');
  }

  /**
   * Play text or URL
   */
  async play(options: {
    text?: string;
    url?: string;
    blocking?: boolean;
  }): Promise<boolean> {
    const { text, url, blocking } = options;
    
    // Clean any thinking tags from the text before playing
    const cleanText = text ? removeThinkingTags(text) : text;
    
    // Use a different timeout based on the content length
    const timeout = blocking
      ? text
        ? Math.max(20, text.length * 0.15) * 1000
        : 20 * 1000
      : 10 * 1000;

    // 新版小爱音箱 Pro
    const newDevice = await this.isNewDevice();
    if (newDevice) {
      const res = await this.runShell(
        url
          ? `curl '${url}' | aplay -Dhw:0,0 -f S16_LE -c 1 -r 24000 -`
          : `/usr/sbin/tts_play.sh '${cleanText || "你好"}'`,
        { timeout }
      );
      return res?.exit_code === 0;
    }

    const res = await this.runShell(
      url
        ? `ubus call mediaplayer player_play_url '${jsonEncode({
            url: url,
            type: 1,
          })}'`
        : `ubus call mibrain text_to_speech '${jsonEncode({
            text: cleanText || "你好",
            save: 0,
          })}'`,
      { timeout }
    );
    return res?.stdout.includes('"code": 0') ?? false;
  }

  /**
   * （取消）唤醒小爱
   */
  async wakeUp(
    awake = true,
    options?: {
      /**
       * 静默唤醒
       */
      silent: boolean;
    }
  ) {
    const { silent = false } = options ?? {};
    const command = awake
      ? silent
        ? `ubus call pnshelper event_notify '{"src":1,"event":0}'`
        : `ubus call pnshelper event_notify '{"src":0,"event":0}'`
      : `
        ubus call pnshelper event_notify '{"src":3, "event":7}'
        sleep 0.1
        ubus call pnshelper event_notify '{"src":3, "event":8}'
    `;
    const res = await this.runShell(command);
    return res?.stdout.includes('"code": 0');
  }

  /**
   * 把文字指令交给原来的小爱执行
   */
  async askXiaoAI(
    text: string,
    options?: {
      /**
       * 静默执行
       */
      silent: boolean;
    }
  ) {
    const { silent = false } = options ?? {};
    const res = await this.runShell(
      `ubus call mibrain ai_service '${jsonEncode({
        tts: silent ? undefined : 1,
        nlp: 1,
        nlp_text: text,
      })}'`
    );
    return res?.stdout.includes('"code": 0');
  }

  /**
   * 中断原来小爱的运行
   *
   * 注意：重启需要大约 1-2s 的时间，在此期间无法使用小爱音箱自带的 TTS 服务
   */
  async abortXiaoAI() {
    const res = await this.runShell(
      "/etc/init.d/mico_aivs_lab restart >/dev/null 2>&1"
    );
    return res?.exit_code === 0;
  }

  /**
   * 获取启动分区
   */
  async getBoot() {
    const res = await this.runShell("echo $(fw_env -g boot_part)");
    return res?.stdout.trim();
  }

  /**
   * 设置启动分区
   */
  async setBoot(boot_part: "boot0" | "boot1") {
    const res = await this.runShell(
      `fw_env -s boot_part ${boot_part} >/dev/null 2>&1 && echo $(fw_env -g boot_part)`
    );
    return res?.stdout.includes(boot_part);
  }

  /**
   * 获取设备型号、序列号信息
   */
  async getDevice() {
    const res = await this.runShell("echo $(micocfg_model) $(micocfg_sn)");
    const info = res?.stdout.trim().split(" ");
    return {
      model: info?.[0] ?? "unknown",
      sn: info?.[1] ?? "unknown",
    };
  }

  /**
   * 获取麦克风状态
   */
  async getMic() {
    const res = await this.runShell(
      "[ ! -f /tmp/mipns/mute ] && echo on || echo off"
    );
    let status: "on" | "off" = "off";
    if (res?.stdout.includes("on")) {
      status = "on";
    }
    return status;
  }

  /**
   * 打开/关闭麦克风
   */
  async setMic(on = true) {
    const res = await this.runShell(
      on
        ? `ubus -t1 -S call pnshelper event_notify '{"src":3, "event":7}' 2>&1`
        : `ubus -t1 -S call pnshelper event_notify '{"src":3, "event":8}' 2>&1`
    );
    return res?.stdout.includes('"code":0');
  }

  /**
   * 执行脚本
   */
  async runShell(
    script: string,
    options?: {
      /**
       * 超时时间（单位：毫秒）
       */
      timeout?: number;
    }
  ): Promise<CommandResult | undefined> {
    const { timeout = 10 * 1000 } = options ?? {};
    try {
      const res = await RustServer.run_shell(script, timeout);
      if (res) {
        return JSON.parse(res);
      }
    } catch (_) {
      return undefined;
    }
  }

  /**
   * 检测是否是新版小爱音箱 Pro
   */
  private async isNewDevice() {
    const res = await this.runShell(
      "cat /proc/cpuinfo | grep Hardware | awk '{print $3}'"
    );
    return res?.stdout?.toLowerCase()?.includes("amlogic");
  }
}

export const OpenXiaoAISpeaker = new SpeakerManager();
