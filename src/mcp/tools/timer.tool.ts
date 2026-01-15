/**
 * Meeting Timer 도구
 * 회의 타이머 관리 (시작, 일시정지, 연장, 중지)
 * LLM 호출 없이 직접 실행
 */

import { McpTool, ToolInput, ToolOutput, LlmCallFn } from '../types/tool.types';

// 타이머 상태 타입
export type TimerState = 'idle' | 'running' | 'paused' | 'warning' | 'ended';

// 타이머 액션 타입
export type TimerAction = 'start' | 'pause' | 'resume' | 'extend' | 'stop' | 'status';

// 타이머 데이터
export interface TimerData {
  roomId: string;
  targetMinutes: number;
  warningMinutes: number;
  remainingSeconds: number;
  timerState: TimerState;
  startedAt?: number;
  endTime?: number;
}

// 타이머 저장소 (메모리 - 서버 재시작 시 초기화)
const timerStore = new Map<string, TimerData>();

// 타이머 인터벌 저장소
const timerIntervals = new Map<string, NodeJS.Timeout>();

// 콜백 함수 타입 (알림 전송용)
type TimerCallback = (roomId: string, event: 'warning' | 'ended', data: TimerData) => void;
let notifyCallback: TimerCallback | null = null;

/**
 * 콜백 등록 (VoiceBot에서 호출)
 */
export function setTimerNotifyCallback(callback: TimerCallback) {
  notifyCallback = callback;
}

/**
 * 타이머 시작
 */
function startTimer(roomId: string, targetMinutes: number, warningMinutes: number): TimerData {
  // 기존 타이머 정리
  stopTimerInterval(roomId);

  const now = Date.now();
  const timerData: TimerData = {
    roomId,
    targetMinutes,
    warningMinutes,
    remainingSeconds: targetMinutes * 60,
    timerState: 'running',
    startedAt: now,
    endTime: now + targetMinutes * 60 * 1000,
  };

  timerStore.set(roomId, timerData);

  // 인터벌 시작 (1초마다)
  const interval = setInterval(() => {
    const timer = timerStore.get(roomId);
    // running 또는 warning 상태에서만 계속 카운트다운
    if (!timer || (timer.timerState !== 'running' && timer.timerState !== 'warning')) {
      stopTimerInterval(roomId);
      return;
    }

    timer.remainingSeconds--;

    // 경고 시간 체크
    const warningThreshold = timer.warningMinutes * 60;
    if (timer.remainingSeconds === warningThreshold && timer.timerState === 'running') {
      timer.timerState = 'warning';
      notifyCallback?.(roomId, 'warning', { ...timer });
    }

    // 종료 체크
    if (timer.remainingSeconds <= 0) {
      timer.remainingSeconds = 0;
      timer.timerState = 'ended';
      stopTimerInterval(roomId);
      notifyCallback?.(roomId, 'ended', { ...timer });
    }

    timerStore.set(roomId, timer);
  }, 1000);

  timerIntervals.set(roomId, interval);

  return timerData;
}

/**
 * 타이머 일시정지
 */
function pauseTimer(roomId: string): TimerData | null {
  const timer = timerStore.get(roomId);
  if (!timer) return null;

  stopTimerInterval(roomId);
  timer.timerState = 'paused';
  timerStore.set(roomId, timer);

  return timer;
}

/**
 * 타이머 재개
 */
function resumeTimer(roomId: string): TimerData | null {
  const timer = timerStore.get(roomId);
  if (!timer || timer.timerState !== 'paused') return null;

  timer.timerState = 'running';
  timer.endTime = Date.now() + timer.remainingSeconds * 1000;
  timerStore.set(roomId, timer);

  // 인터벌 재시작
  const interval = setInterval(() => {
    const t = timerStore.get(roomId);
    // running 또는 warning 상태에서만 계속 카운트다운
    if (!t || (t.timerState !== 'running' && t.timerState !== 'warning')) {
      stopTimerInterval(roomId);
      return;
    }

    t.remainingSeconds--;

    const warningThreshold = t.warningMinutes * 60;
    if (t.remainingSeconds === warningThreshold && t.timerState === 'running') {
      t.timerState = 'warning';
      notifyCallback?.(roomId, 'warning', { ...t });
    }

    if (t.remainingSeconds <= 0) {
      t.remainingSeconds = 0;
      t.timerState = 'ended';
      stopTimerInterval(roomId);
      notifyCallback?.(roomId, 'ended', { ...t });
    }

    timerStore.set(roomId, t);
  }, 1000);

  timerIntervals.set(roomId, interval);

  return timer;
}

/**
 * 타이머 연장
 */
function extendTimer(roomId: string, minutes: number): TimerData | null {
  const timer = timerStore.get(roomId);
  if (!timer) return null;

  timer.remainingSeconds += minutes * 60;
  timer.targetMinutes += minutes;

  // 종료 또는 경고 상태였으면 running으로 변경
  if (timer.timerState === 'ended' || timer.timerState === 'warning') {
    timer.timerState = 'running';
    timer.endTime = Date.now() + timer.remainingSeconds * 1000;

    // 인터벌 재시작
    if (!timerIntervals.has(roomId)) {
      const interval = setInterval(() => {
        const t = timerStore.get(roomId);
        // running 또는 warning 상태에서만 계속 카운트다운
        if (!t || (t.timerState !== 'running' && t.timerState !== 'warning')) {
          stopTimerInterval(roomId);
          return;
        }

        t.remainingSeconds--;

        const warningThreshold = t.warningMinutes * 60;
        if (t.remainingSeconds === warningThreshold && t.timerState === 'running') {
          t.timerState = 'warning';
          notifyCallback?.(roomId, 'warning', { ...t });
        }

        if (t.remainingSeconds <= 0) {
          t.remainingSeconds = 0;
          t.timerState = 'ended';
          stopTimerInterval(roomId);
          notifyCallback?.(roomId, 'ended', { ...t });
        }

        timerStore.set(roomId, t);
      }, 1000);

      timerIntervals.set(roomId, interval);
    }
  }

  timerStore.set(roomId, timer);
  return timer;
}

/**
 * 타이머 중지
 */
function stopTimer(roomId: string): TimerData | null {
  const timer = timerStore.get(roomId);
  stopTimerInterval(roomId);
  timerStore.delete(roomId);
  return timer || null;
}

/**
 * 타이머 상태 조회
 */
function getTimerStatus(roomId: string): TimerData | null {
  return timerStore.get(roomId) || null;
}

/**
 * 인터벌 정리
 */
function stopTimerInterval(roomId: string) {
  const interval = timerIntervals.get(roomId);
  if (interval) {
    clearInterval(interval);
    timerIntervals.delete(roomId);
  }
}

/**
 * 타이머 MCP 도구
 */
export const timerTool: McpTool = {
  name: 'timer',
  description: '회의 타이머 관리 (시작, 일시정지, 연장, 중지)',
  category: 'management',
  keywords: ['타이머', 'timer', '시간', '알림', '회의시간', '종료'],

  async execute(input: ToolInput, _llmCall: LlmCallFn): Promise<ToolOutput> {
    const { context, options } = input;
    const roomId = context?.roomId;

    if (!roomId) {
      throw new Error('roomId가 필요합니다');
    }

    const action = options?.action as TimerAction;
    let result: TimerData | null = null;
    let message = '';

    switch (action) {
      case 'start': {
        const targetMinutes = options?.targetMinutes || 30;
        const warningMinutes = options?.warningMinutes || 5;
        result = startTimer(roomId, targetMinutes, warningMinutes);
        message = `${targetMinutes}분 타이머가 시작되었습니다. ${warningMinutes}분 전에 알림을 드릴게요.`;
        break;
      }

      case 'pause':
        result = pauseTimer(roomId);
        message = result ? '타이머가 일시정지되었습니다.' : '실행 중인 타이머가 없습니다.';
        break;

      case 'resume':
        result = resumeTimer(roomId);
        message = result ? '타이머가 재개되었습니다.' : '일시정지된 타이머가 없습니다.';
        break;

      case 'extend': {
        const minutes = options?.minutes || 10;
        result = extendTimer(roomId, minutes);
        message = result ? `${minutes}분 연장되었습니다.` : '타이머가 없습니다.';
        break;
      }

      case 'stop':
        result = stopTimer(roomId);
        message = result ? '타이머가 중지되었습니다.' : '타이머가 없습니다.';
        break;

      case 'status':
        result = getTimerStatus(roomId);
        if (result) {
          const mins = Math.floor(result.remainingSeconds / 60);
          const secs = result.remainingSeconds % 60;
          message = `현재 ${mins}분 ${secs}초 남았습니다. 상태: ${result.timerState}`;
        } else {
          message = '설정된 타이머가 없습니다.';
        }
        break;

      default:
        throw new Error(`알 수 없는 액션: ${action}`);
    }

    return {
      type: 'timer',
      data: result,
      markdown: message,
      metadata: {
        generatedAt: new Date().toISOString(),
        toolName: 'timer',
        editable: false,
      },
    };
  },
};

// 외부에서 직접 호출할 수 있는 함수들 export
export {
  startTimer,
  pauseTimer,
  resumeTimer,
  extendTimer,
  stopTimer,
  getTimerStatus,
  timerStore,
};
