/**
 * RAG 클라이언트 공통 인터페이스
 * WebSocket과 gRPC 클라이언트 모두 이 인터페이스를 구현
 */
export interface IRagClient {
    /**
     * RAG 서버에 연결 (세션 생성)
     */
    connect(roomId: string): Promise<void>;

    /**
     * 연결 해제 (세션 종료)
     */
    disconnect(roomId: string): Promise<void>;

    /**
     * 연결 상태 확인
     */
    isConnected(roomId: string): boolean;

    /**
     * 발언 전송 (인덱싱)
     */
    sendStatement(roomId: string, text: string, speaker: string): Promise<void>;

    /**
     * 질문 전송 및 응답 대기
     */
    sendQuestion(roomId: string, text: string): Promise<string>;

    /**
     * 연결 상태 반환
     */
    getConnectionStatus(roomId: string): { connected: boolean; roomId: string };

    /**
     * 전체 연결 현황 반환
     */
    getAllConnectionsStatus(): { total: number; clients: string[] };

    /**
     * 회의 종료
     */
    endMeeting(roomName: string): Promise<{ success: boolean; message?: string }>;

    /**
     * 회의 시작
     */
    startMeeting(roomName: string, payload: any): Promise<{ success: boolean; message?: string }>;
}

/**
 * RAG 클라이언트 타입
 */
export type RagClientType = 'websocket' | 'grpc';

/**
 * RAG 클라이언트 주입 토큰
 */
export const RAG_CLIENT = 'RAG_CLIENT';
