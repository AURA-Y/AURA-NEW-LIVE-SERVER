import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface CalendarEvent {
    id: string;
    title: string;
    start: {
        dateTime?: string;
        date?: string;
    };
    end: {
        dateTime?: string;
        date?: string;
    };
}

export interface FreeSlot {
    start: string;
    end: string;
}

export interface ParticipantSchedule {
    participantId: string;
    participantName: string;
    events: CalendarEvent[];
    connected: boolean;
}

@Injectable()
export class CalendarService {
    private readonly logger = new Logger(CalendarService.name);
    private readonly apiBackendUrl: string;
    private readonly internalApiKey: string;

    constructor(private configService: ConfigService) {
        this.apiBackendUrl = this.configService.get<string>('API_BACKEND_URL') || 'http://localhost:3002';
        this.internalApiKey = this.configService.get<string>('INTERNAL_API_KEY') || 'internal-secret-key';
    }

    /**
     * 여러 참여자의 공통 빈 시간대 찾기
     */
    async findCommonFreeSlots(params: {
        userIds: string[];
        timeMin: string;
        timeMax: string;
        durationMinutes?: number;
    }): Promise<FreeSlot[]> {
        const { userIds, timeMin, timeMax, durationMinutes = 60 } = params;

        this.logger.log(`[캘린더] 공통 빈 시간 검색 - 참여자: ${userIds.length}명, 기간: ${timeMin} ~ ${timeMax}`);

        try {
            const axios = await import('axios');
            const response = await axios.default.post(
                `${this.apiBackendUrl}/restapi/calendar/internal/find-free-slots`,
                {
                    userIds,
                    timeMin,
                    timeMax,
                    durationMinutes,
                },
                {
                    headers: {
                        'x-internal-api-key': this.internalApiKey,
                        'Content-Type': 'application/json',
                    },
                }
            );

            const freeSlots = response.data?.freeSlots || [];
            this.logger.log(`[캘린더] 빈 시간 ${freeSlots.length}개 발견`);
            return freeSlots;
        } catch (error: any) {
            this.logger.error(`[캘린더] 빈 시간 검색 실패: ${error.message}`);
            return [];
        }
    }

    /**
     * 특정 사용자의 캘린더 이벤트 조회
     */
    async getUserCalendarEvents(params: {
        userId: string;
        maxResults?: number;
        timeMin?: string;
        timeMax?: string;
        accessToken: string;
    }): Promise<CalendarEvent[]> {
        const { maxResults = 10, timeMin, timeMax, accessToken } = params;

        try {
            const axios = await import('axios');
            const queryParams = new URLSearchParams();
            if (maxResults) queryParams.append('maxResults', maxResults.toString());
            if (timeMin) queryParams.append('timeMin', timeMin);
            if (timeMax) queryParams.append('timeMax', timeMax);

            const response = await axios.default.get(
                `${this.apiBackendUrl}/restapi/calendar/user/events?${queryParams.toString()}`,
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                    },
                }
            );

            return response.data?.events || [];
        } catch (error: any) {
            this.logger.error(`[캘린더] 사용자 이벤트 조회 실패: ${error.message}`);
            return [];
        }
    }

    /**
     * Google 연동 상태 확인
     */
    async checkGoogleConnection(accessToken: string): Promise<boolean> {
        try {
            const axios = await import('axios');
            const response = await axios.default.get(
                `${this.apiBackendUrl}/restapi/calendar/oauth/status`,
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                    },
                }
            );

            return response.data?.connected === true;
        } catch (error: any) {
            this.logger.error(`[캘린더] Google 연동 상태 확인 실패: ${error.message}`);
            return false;
        }
    }

    /**
     * 빈 시간대를 자연어 응답으로 변환
     */
    formatFreeSlotsResponse(freeSlots: FreeSlot[], participantCount: number): string {
        if (freeSlots.length === 0) {
            return `${participantCount}명의 참여자 일정을 확인했지만, 공통으로 비어 있는 시간을 찾지 못했습니다. 개별적으로 일정을 조율해 보시는 것이 좋겠습니다.`;
        }

        const slotDescriptions = freeSlots.slice(0, 5).map((slot, index) => {
            const start = new Date(slot.start);
            const end = new Date(slot.end);

            const dateStr = start.toLocaleDateString('ko-KR', {
                month: 'long',
                day: 'numeric',
                weekday: 'short',
            });

            const startTime = start.toLocaleTimeString('ko-KR', {
                hour: '2-digit',
                minute: '2-digit',
            });

            const endTime = end.toLocaleTimeString('ko-KR', {
                hour: '2-digit',
                minute: '2-digit',
            });

            return `${index + 1}. ${dateStr} ${startTime} ~ ${endTime}`;
        });

        let response = `${participantCount}명의 참여자 일정을 분석한 결과, 다음 시간대가 모두 비어 있습니다.\n\n`;
        response += slotDescriptions.join('\n');

        if (freeSlots.length > 5) {
            response += `\n\n이 외에도 ${freeSlots.length - 5}개의 가능한 시간대가 더 있습니다.`;
        }

        response += '\n\n원하시는 시간대가 있으시면 말씀해 주세요.';

        return response;
    }

    /**
     * 다음 주 기간 계산 (timeMin, timeMax)
     */
    getNextWeekRange(): { timeMin: string; timeMax: string } {
        const now = new Date();
        const nextMonday = new Date(now);
        nextMonday.setDate(now.getDate() + ((1 + 7 - now.getDay()) % 7 || 7));
        nextMonday.setHours(9, 0, 0, 0);

        const nextFriday = new Date(nextMonday);
        nextFriday.setDate(nextMonday.getDate() + 4);
        nextFriday.setHours(18, 0, 0, 0);

        return {
            timeMin: nextMonday.toISOString(),
            timeMax: nextFriday.toISOString(),
        };
    }

    /**
     * 이번 주 남은 기간 계산
     */
    getThisWeekRemaining(): { timeMin: string; timeMax: string } {
        const now = new Date();
        const timeMin = new Date(now);
        timeMin.setHours(now.getHours() + 1, 0, 0, 0); // 1시간 후부터

        const friday = new Date(now);
        const daysUntilFriday = (5 - now.getDay() + 7) % 7 || 7;
        friday.setDate(now.getDate() + daysUntilFriday);
        friday.setHours(18, 0, 0, 0);

        return {
            timeMin: timeMin.toISOString(),
            timeMax: friday.toISOString(),
        };
    }
}
