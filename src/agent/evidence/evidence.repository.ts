import { Injectable, Logger } from '@nestjs/common';
import {
    VerifiedEvidence,
    EvidenceMatchResult,
    DEFAULT_OPINION_CONFIG,
    OpinionConfig,
} from './evidence.interface';

/**
 * 검증된 Evidence 저장소
 *
 * 사전 검증된 사실 데이터를 관리하고 토픽 매칭 기능 제공
 * 현재는 메모리 기반, 추후 DB 연동 가능
 */
@Injectable()
export class EvidenceRepository {
    private readonly logger = new Logger(EvidenceRepository.name);
    private readonly evidenceMap: Map<string, VerifiedEvidence> = new Map();
    private config: OpinionConfig = DEFAULT_OPINION_CONFIG;

    constructor() {
        this.initializeDefaultEvidence();
    }

    /**
     * 초기 Evidence 데이터 로드
     * 실제 검증된 데이터만 포함
     */
    private initializeDefaultEvidence(): void {
        const defaultEvidence: VerifiedEvidence[] = [
            // ===== 개발 언어/프레임워크 =====
            {
                id: 'so-survey-2024-typescript',
                topic: 'TypeScript 선호도',
                keywords: ['타입스크립트', 'typescript', 'ts', '언어 선택', '프론트엔드 언어'],
                fact: '65,000명 이상의 개발자 중 약 38.5%가 TypeScript를 사용하며, 가장 원하는 언어 상위권에 랭크되었습니다',
                sourceName: '2024 StackOverflow Developer Survey',
                sourceType: 'large_survey',
                sourceUrl: 'https://survey.stackoverflow.co/2024/',
                verifiedDate: '2024-05',
                participantCount: 65000,
                category: 'development',
                isActive: true,
            },
            {
                id: 'so-survey-2024-react',
                topic: 'React 프레임워크 사용률',
                keywords: ['리액트', 'react', '프론트엔드', '프레임워크', 'UI 라이브러리'],
                fact: '웹 프레임워크 중 React가 약 39.5%의 사용률로 1위를 차지했습니다',
                sourceName: '2024 StackOverflow Developer Survey',
                sourceType: 'large_survey',
                sourceUrl: 'https://survey.stackoverflow.co/2024/',
                verifiedDate: '2024-05',
                participantCount: 65000,
                category: 'development',
                isActive: true,
            },
            {
                id: 'jetbrains-2023-ide',
                topic: 'IDE 사용 통계',
                keywords: ['ide', 'vscode', 'intellij', '에디터', '개발환경', 'vs code'],
                fact: 'Visual Studio Code가 약 72%의 사용률로 가장 많이 사용되는 IDE입니다',
                sourceName: '2023 JetBrains Developer Ecosystem Survey',
                sourceType: 'large_survey',
                sourceUrl: 'https://www.jetbrains.com/lp/devecosystem-2023/',
                verifiedDate: '2023-06',
                participantCount: 26000,
                category: 'development',
                isActive: true,
            },

            // ===== 보안 =====
            {
                id: 'owasp-session-jwt',
                topic: 'JWT 토큰 유효시간 권장사항',
                keywords: ['jwt', '토큰', '유효시간', '만료', 'access token', '세션', '인증'],
                fact: 'Access Token은 15분~2시간, Refresh Token은 최대 24시간을 권장합니다. 민감한 작업에는 더 짧은 시간을 권장합니다',
                sourceName: 'OWASP Session Management Cheat Sheet',
                sourceType: 'standard_organization',
                sourceUrl: 'https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html',
                verifiedDate: '2024-01',
                category: 'security',
                isActive: true,
            },
            {
                id: 'owasp-password-hash',
                topic: '비밀번호 해싱 알고리즘',
                keywords: ['비밀번호', '해싱', 'bcrypt', 'argon2', '암호화', 'password'],
                fact: 'Argon2id를 최우선으로 권장하며, bcrypt(cost 10 이상) 또는 scrypt를 대안으로 권장합니다. MD5, SHA1은 비밀번호 해싱에 사용하면 안 됩니다',
                sourceName: 'OWASP Password Storage Cheat Sheet',
                sourceType: 'standard_organization',
                sourceUrl: 'https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html',
                verifiedDate: '2024-01',
                category: 'security',
                isActive: true,
            },

            // ===== 인프라/DevOps =====
            {
                id: 'cncf-kubernetes-2023',
                topic: 'Kubernetes 채택률',
                keywords: ['쿠버네티스', 'kubernetes', 'k8s', '컨테이너', '오케스트레이션'],
                fact: '전 세계적으로 84%의 조직이 Kubernetes를 프로덕션에서 사용하거나 평가 중입니다',
                sourceName: 'CNCF Annual Survey 2023',
                sourceType: 'large_survey',
                sourceUrl: 'https://www.cncf.io/reports/cncf-annual-survey-2023/',
                verifiedDate: '2023-12',
                participantCount: 17000,
                category: 'infrastructure',
                isActive: true,
            },
            {
                id: 'github-copilot-productivity',
                topic: 'AI 코딩 도구 생산성',
                keywords: ['copilot', 'ai 코딩', '코파일럿', 'github copilot', '생산성'],
                fact: 'GitHub Copilot 사용자의 88%가 생산성이 향상되었다고 응답했으며, 평균 55% 더 빠르게 작업을 완료했습니다',
                sourceName: 'GitHub Copilot Research Study',
                sourceType: 'official_announcement',
                sourceUrl: 'https://github.blog/2022-09-07-research-quantifying-github-copilots-impact-on-developer-productivity-and-happiness/',
                verifiedDate: '2022-09',
                category: 'development',
                isActive: true,
            },

            // ===== 아키텍처/설계 =====
            {
                id: 'google-sre-slo',
                topic: 'SLO/SLI 설정 권장사항',
                keywords: ['slo', 'sli', 'sre', '가용성', 'availability', '99.9', '99.99'],
                fact: 'Google SRE는 99.9% (three nines)를 대부분의 서비스에 적절한 목표로 권장하며, 99.99%는 매우 중요한 시스템에만 권장합니다',
                sourceName: 'Google SRE Book',
                sourceType: 'official_announcement',
                sourceUrl: 'https://sre.google/sre-book/service-level-objectives/',
                verifiedDate: '2023-01',
                category: 'infrastructure',
                isActive: true,
            },
            {
                id: 'martin-fowler-microservices',
                topic: '마이크로서비스 도입 시점',
                keywords: ['마이크로서비스', 'microservices', '모놀리스', 'monolith', '아키텍처'],
                fact: 'Martin Fowler는 "Monolith First" 접근을 권장합니다. 처음부터 마이크로서비스로 시작하지 말고, 도메인을 충분히 이해한 후 분리할 것을 권장합니다',
                sourceName: 'Martin Fowler - MonolithFirst',
                sourceType: 'official_announcement',
                sourceUrl: 'https://martinfowler.com/bliki/MonolithFirst.html',
                verifiedDate: '2015-06',
                category: 'architecture',
                isActive: true,
            },

            // ===== 테스트 =====
            {
                id: 'google-test-pyramid',
                topic: '테스트 피라미드 비율',
                keywords: ['테스트', 'unit test', '유닛 테스트', '통합 테스트', 'e2e', '테스트 비율'],
                fact: 'Google은 테스트 비율을 Unit 70%, Integration 20%, E2E 10%로 권장합니다 (테스트 피라미드)',
                sourceName: 'Google Testing Blog',
                sourceType: 'official_announcement',
                sourceUrl: 'https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html',
                verifiedDate: '2015-04',
                category: 'testing',
                isActive: true,
            },

            // ===== 데이터베이스 =====
            {
                id: 'so-survey-2024-postgres',
                topic: 'PostgreSQL 인기도',
                keywords: ['postgres', 'postgresql', '포스트그레스', '데이터베이스', 'db 선택', 'rdbms'],
                fact: 'PostgreSQL이 48.7%로 가장 많이 사용되는 데이터베이스이며, 가장 원하는 데이터베이스 1위입니다',
                sourceName: '2024 StackOverflow Developer Survey',
                sourceType: 'large_survey',
                sourceUrl: 'https://survey.stackoverflow.co/2024/',
                verifiedDate: '2024-05',
                participantCount: 65000,
                category: 'database',
                isActive: true,
            },
            {
                id: 'so-survey-2024-redis',
                topic: 'Redis 사용률',
                keywords: ['redis', '레디스', '캐시', 'cache', '인메모리', 'nosql'],
                fact: 'Redis가 NoSQL 데이터베이스 중 가장 높은 사용률을 보이며, 캐싱과 세션 관리에 가장 많이 사용됩니다',
                sourceName: '2024 StackOverflow Developer Survey',
                sourceType: 'large_survey',
                sourceUrl: 'https://survey.stackoverflow.co/2024/',
                verifiedDate: '2024-05',
                participantCount: 65000,
                category: 'database',
                isActive: true,
            },
            {
                id: 'so-survey-2024-mongodb',
                topic: 'MongoDB 사용 사례',
                keywords: ['mongodb', '몽고디비', 'nosql', '도큐먼트', 'document db'],
                fact: 'MongoDB는 도큐먼트 DB 중 가장 높은 사용률을 보이며, 스키마 유연성이 필요한 프로젝트에서 주로 선택됩니다',
                sourceName: '2024 StackOverflow Developer Survey',
                sourceType: 'large_survey',
                sourceUrl: 'https://survey.stackoverflow.co/2024/',
                verifiedDate: '2024-05',
                participantCount: 65000,
                category: 'database',
                isActive: true,
            },

            // ===== 상태 관리 =====
            {
                id: 'so-survey-2024-state-management',
                topic: 'React 상태 관리 트렌드',
                keywords: ['상태 관리', 'state management', 'redux', 'zustand', 'recoil', 'jotai', 'context'],
                fact: 'React 프로젝트에서 Zustand와 같은 경량 상태 관리 라이브러리 사용이 증가하는 추세이며, Redux는 여전히 대규모 프로젝트에서 선호됩니다',
                sourceName: '2024 State of JS Survey',
                sourceType: 'large_survey',
                sourceUrl: 'https://stateofjs.com/2024/',
                verifiedDate: '2024-06',
                participantCount: 23000,
                category: 'development',
                isActive: true,
            },

            // ===== API 설계 =====
            {
                id: 'postman-api-2023',
                topic: 'REST vs GraphQL 선택',
                keywords: ['rest', 'graphql', 'api', 'api 설계', 'restful', 'grpc'],
                fact: 'REST API가 여전히 89%로 가장 많이 사용되지만, GraphQL 사용률이 28%로 꾸준히 증가 중입니다. 복잡한 데이터 요구사항에는 GraphQL이 선호됩니다',
                sourceName: '2023 Postman State of the API Report',
                sourceType: 'large_survey',
                sourceUrl: 'https://www.postman.com/state-of-api/',
                verifiedDate: '2023-10',
                participantCount: 40000,
                category: 'architecture',
                isActive: true,
            },
            {
                id: 'google-api-versioning',
                topic: 'API 버전 관리',
                keywords: ['api 버전', 'versioning', 'api version', 'v1', 'v2', 'breaking change'],
                fact: 'Google은 URL 경로에 major 버전을 포함하는 방식(예: /v1/users)을 권장하며, 하위 호환성 유지를 강조합니다',
                sourceName: 'Google API Design Guide',
                sourceType: 'official_announcement',
                sourceUrl: 'https://cloud.google.com/apis/design/versioning',
                verifiedDate: '2024-01',
                category: 'architecture',
                isActive: true,
            },

            // ===== 인증/인가 =====
            {
                id: 'owasp-oauth2',
                topic: 'OAuth 2.0 구현',
                keywords: ['oauth', 'oauth2', '소셜 로그인', 'authorization', '인증', '인가'],
                fact: 'PKCE(Proof Key for Code Exchange)를 모든 OAuth 2.0 클라이언트에서 사용할 것을 권장합니다. SPA나 모바일 앱에서는 필수입니다',
                sourceName: 'OWASP OAuth 2.0 Cheat Sheet',
                sourceType: 'standard_organization',
                sourceUrl: 'https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html',
                verifiedDate: '2024-01',
                category: 'security',
                isActive: true,
            },
            {
                id: 'auth0-mfa-stats',
                topic: 'MFA 도입 효과',
                keywords: ['mfa', '2fa', '이중 인증', '다중 인증', 'multi factor', 'otp'],
                fact: 'MFA를 도입하면 계정 탈취 공격의 99.9%를 방지할 수 있습니다. SMS보다 앱 기반 OTP나 하드웨어 키를 권장합니다',
                sourceName: 'Microsoft Security Research',
                sourceType: 'official_announcement',
                sourceUrl: 'https://www.microsoft.com/security/blog/2019/08/20/one-simple-action-you-can-take-to-prevent-99-9-percent-of-account-attacks/',
                verifiedDate: '2023-01',
                category: 'security',
                isActive: true,
            },

            // ===== 프론트엔드 =====
            {
                id: 'so-survey-2024-nextjs',
                topic: 'Next.js 사용률',
                keywords: ['nextjs', 'next.js', 'next', 'ssr', 'server side rendering', 'react framework'],
                fact: 'Next.js가 React 메타 프레임워크 중 가장 높은 채택률을 보이며, SSR이 필요한 프로젝트에서 표준으로 자리잡고 있습니다',
                sourceName: '2024 State of JS Survey',
                sourceType: 'large_survey',
                sourceUrl: 'https://stateofjs.com/2024/',
                verifiedDate: '2024-06',
                participantCount: 23000,
                category: 'development',
                isActive: true,
            },
            {
                id: 'so-survey-2024-tailwind',
                topic: 'Tailwind CSS 사용률',
                keywords: ['tailwind', 'css', '스타일링', 'styled-components', 'css-in-js'],
                fact: 'Tailwind CSS 사용률이 급증하여 CSS 프레임워크 중 만족도 1위를 기록했습니다. 유틸리티 퍼스트 접근 방식이 생산성을 높인다는 평가입니다',
                sourceName: '2024 State of CSS Survey',
                sourceType: 'large_survey',
                sourceUrl: 'https://stateofcss.com/2024/',
                verifiedDate: '2024-06',
                participantCount: 14000,
                category: 'development',
                isActive: true,
            },

            // ===== 백엔드 =====
            {
                id: 'so-survey-2024-nestjs',
                topic: 'NestJS 사용률',
                keywords: ['nestjs', 'nest', 'node 프레임워크', 'express', 'fastify', '백엔드 프레임워크'],
                fact: 'NestJS가 Node.js 백엔드 프레임워크 중 만족도가 가장 높으며, 엔터프라이즈 프로젝트에서 채택이 증가하고 있습니다',
                sourceName: '2024 State of JS Survey',
                sourceType: 'large_survey',
                sourceUrl: 'https://stateofjs.com/2024/',
                verifiedDate: '2024-06',
                participantCount: 23000,
                category: 'development',
                isActive: true,
            },

            // ===== 모니터링/로깅 =====
            {
                id: 'datadog-observability-2023',
                topic: '로깅 구조화',
                keywords: ['로깅', 'logging', '로그', 'structured logging', 'json log', '모니터링'],
                fact: '구조화된 JSON 로깅을 사용하면 로그 분석 시간이 평균 40% 단축됩니다. 컨텍스트 정보(trace_id, user_id 등)를 포함할 것을 권장합니다',
                sourceName: 'Datadog State of Observability 2023',
                sourceType: 'large_survey',
                sourceUrl: 'https://www.datadoghq.com/state-of-observability/',
                verifiedDate: '2023-11',
                participantCount: 12000,
                category: 'infrastructure',
                isActive: true,
            },

            // ===== CI/CD =====
            {
                id: 'dora-2023-deployment',
                topic: '배포 빈도와 성과',
                keywords: ['배포', 'deployment', 'ci/cd', 'cicd', 'devops', '파이프라인'],
                fact: '엘리트 성과 팀은 하루에 여러 번 배포하며, 변경 실패율이 15% 미만입니다. 자동화된 테스트와 배포 파이프라인이 핵심입니다',
                sourceName: 'DORA State of DevOps Report 2023',
                sourceType: 'large_survey',
                sourceUrl: 'https://dora.dev/research/',
                verifiedDate: '2023-10',
                participantCount: 36000,
                category: 'infrastructure',
                isActive: true,
            },
            {
                id: 'github-actions-2024',
                topic: 'CI/CD 도구 선택',
                keywords: ['github actions', 'jenkins', 'gitlab ci', 'ci 도구', 'circleci'],
                fact: 'GitHub Actions가 CI/CD 도구 중 가장 빠르게 성장하고 있으며, GitHub 사용자 중 63%가 Actions를 사용합니다',
                sourceName: 'GitHub Octoverse 2023',
                sourceType: 'official_announcement',
                sourceUrl: 'https://octoverse.github.com/',
                verifiedDate: '2023-11',
                category: 'infrastructure',
                isActive: true,
            },

            // ===== 컨테이너/클라우드 =====
            {
                id: 'docker-2024-compose',
                topic: 'Docker Compose 사용',
                keywords: ['docker', '도커', 'compose', '컨테이너', 'container', '로컬 개발'],
                fact: 'Docker Compose가 로컬 개발 환경 구성에 가장 많이 사용되며, 개발자의 87%가 컨테이너를 사용합니다',
                sourceName: 'Docker 2024 Survey',
                sourceType: 'large_survey',
                sourceUrl: 'https://www.docker.com/resources/state-of-the-developer-survey/',
                verifiedDate: '2024-02',
                participantCount: 15000,
                category: 'infrastructure',
                isActive: true,
            },

            // ===== 코드 품질 =====
            {
                id: 'sonarqube-code-coverage',
                topic: '코드 커버리지 목표',
                keywords: ['커버리지', 'coverage', '코드 품질', 'code quality', '테스트 커버리지'],
                fact: '80% 이상의 코드 커버리지가 일반적인 목표이지만, 중요한 비즈니스 로직은 90% 이상을 권장합니다. 단, 커버리지 수치보다 테스트 품질이 더 중요합니다',
                sourceName: 'SonarQube Best Practices',
                sourceType: 'official_announcement',
                sourceUrl: 'https://docs.sonarqube.org/latest/user-guide/metric-definitions/',
                verifiedDate: '2024-01',
                category: 'testing',
                isActive: true,
            },

            // ===== 에러 처리 =====
            {
                id: 'aws-retry-pattern',
                topic: '재시도 전략',
                keywords: ['retry', '재시도', 'exponential backoff', '백오프', 'resilience', '장애 처리'],
                fact: 'AWS는 Exponential Backoff with Jitter를 권장합니다. 초기 대기시간 100ms, 최대 대기시간 설정, 랜덤 지터 추가가 표준 패턴입니다',
                sourceName: 'AWS Architecture Best Practices',
                sourceType: 'official_announcement',
                sourceUrl: 'https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/',
                verifiedDate: '2023-01',
                category: 'architecture',
                isActive: true,
            },

            // ===== 메시징 =====
            {
                id: 'confluent-kafka-2023',
                topic: 'Kafka 사용 사례',
                keywords: ['kafka', '카프카', '메시지 큐', 'message queue', 'event driven', '이벤트 드리븐'],
                fact: 'Kafka는 초당 수백만 메시지 처리가 필요한 경우에 적합하며, 80% 이상의 Fortune 100 기업이 사용 중입니다',
                sourceName: 'Confluent 2023 Data Streaming Report',
                sourceType: 'large_survey',
                sourceUrl: 'https://www.confluent.io/resources/report/',
                verifiedDate: '2023-09',
                participantCount: 10000,
                category: 'infrastructure',
                isActive: true,
            },

            // ===== 보안 추가 =====
            {
                id: 'owasp-input-validation',
                topic: '입력 유효성 검사',
                keywords: ['validation', '유효성 검사', 'input', '입력 검증', 'sanitize', 'xss'],
                fact: '서버 사이드 유효성 검사는 필수이며, 화이트리스트 방식을 권장합니다. 클라이언트 검증은 UX용이지 보안용이 아닙니다',
                sourceName: 'OWASP Input Validation Cheat Sheet',
                sourceType: 'standard_organization',
                sourceUrl: 'https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html',
                verifiedDate: '2024-01',
                category: 'security',
                isActive: true,
            },
            {
                id: 'owasp-cors',
                topic: 'CORS 설정',
                keywords: ['cors', '크로스 오리진', 'cross origin', 'access-control', '보안 헤더'],
                fact: '프로덕션에서 Access-Control-Allow-Origin: *는 피해야 하며, 허용된 도메인을 명시적으로 지정해야 합니다',
                sourceName: 'OWASP CORS Cheat Sheet',
                sourceType: 'standard_organization',
                sourceUrl: 'https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html',
                verifiedDate: '2024-01',
                category: 'security',
                isActive: true,
            },

            // ===== 성능 =====
            {
                id: 'google-web-vitals',
                topic: '웹 성능 지표',
                keywords: ['web vitals', 'lcp', 'fid', 'cls', '성능', 'performance', '웹 성능'],
                fact: 'Google은 LCP 2.5초 이하, FID 100ms 이하, CLS 0.1 이하를 좋은 사용자 경험의 기준으로 제시합니다',
                sourceName: 'Google Web Vitals',
                sourceType: 'official_announcement',
                sourceUrl: 'https://web.dev/vitals/',
                verifiedDate: '2024-01',
                category: 'development',
                isActive: true,
            },

            // ===== ORM =====
            {
                id: 'prisma-2024',
                topic: 'ORM 선택',
                keywords: ['orm', 'prisma', 'typeorm', 'sequelize', '데이터베이스 접근'],
                fact: 'Node.js 환경에서 Prisma의 채택률이 빠르게 증가하고 있으며, 타입 안정성과 개발 경험에서 높은 평가를 받고 있습니다',
                sourceName: '2024 State of JS Survey',
                sourceType: 'large_survey',
                sourceUrl: 'https://stateofjs.com/2024/',
                verifiedDate: '2024-06',
                participantCount: 23000,
                category: 'development',
                isActive: true,
            },

            // ===== 버전 관리 =====
            {
                id: 'conventional-commits',
                topic: '커밋 메시지 컨벤션',
                keywords: ['commit', '커밋', '커밋 메시지', 'conventional commits', 'git'],
                fact: 'Conventional Commits 형식(feat:, fix:, docs: 등)을 사용하면 자동 버전 관리와 CHANGELOG 생성이 가능합니다',
                sourceName: 'Conventional Commits Specification',
                sourceType: 'standard_organization',
                sourceUrl: 'https://www.conventionalcommits.org/',
                verifiedDate: '2024-01',
                category: 'development',
                isActive: true,
            },
        ];

        // Evidence 맵에 등록
        for (const evidence of defaultEvidence) {
            this.evidenceMap.set(evidence.id, evidence);
        }

        this.logger.log(`Initialized ${this.evidenceMap.size} verified evidence items`);
    }

    /**
     * 설정 업데이트
     */
    setConfig(config: Partial<OpinionConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * 현재 설정 조회
     */
    getConfig(): OpinionConfig {
        return { ...this.config };
    }

    /**
     * 모든 Evidence 조회
     */
    getAll(): VerifiedEvidence[] {
        return Array.from(this.evidenceMap.values()).filter(e => e.isActive);
    }

    /**
     * ID로 Evidence 조회
     */
    getById(id: string): VerifiedEvidence | undefined {
        return this.evidenceMap.get(id);
    }

    /**
     * 카테고리별 Evidence 조회
     */
    getByCategory(category: string): VerifiedEvidence[] {
        return this.getAll().filter(e => e.category === category);
    }

    /**
     * Evidence 추가
     */
    add(evidence: VerifiedEvidence): void {
        this.evidenceMap.set(evidence.id, evidence);
        this.logger.log(`Added evidence: ${evidence.id} - ${evidence.topic}`);
    }

    /**
     * Evidence 비활성화
     */
    deactivate(id: string): boolean {
        const evidence = this.evidenceMap.get(id);
        if (evidence) {
            evidence.isActive = false;
            return true;
        }
        return false;
    }

    /**
     * 대화 텍스트에서 관련 Evidence 찾기
     *
     * @param text 대화 텍스트
     * @returns 매칭된 Evidence 목록 (신뢰도 순 정렬)
     */
    findRelevantEvidence(text: string): EvidenceMatchResult[] {
        const results: EvidenceMatchResult[] = [];
        const normalizedText = text.toLowerCase();

        for (const evidence of this.getAll()) {
            // Evidence 유효성 검증
            if (!this.isEvidenceValid(evidence)) {
                continue;
            }

            const matchedKeywords: string[] = [];
            let keywordScore = 0;

            // 키워드 매칭
            for (const keyword of evidence.keywords) {
                if (normalizedText.includes(keyword.toLowerCase())) {
                    matchedKeywords.push(keyword);
                    keywordScore += this.getKeywordWeight(keyword);
                }
            }

            // 토픽 매칭 (부분 일치)
            const topicWords = evidence.topic.toLowerCase().split(' ');
            let topicMatchCount = 0;
            for (const word of topicWords) {
                if (word.length > 1 && normalizedText.includes(word)) {
                    topicMatchCount++;
                }
            }

            // 신뢰도 계산
            const confidence = this.calculateConfidence(
                matchedKeywords.length,
                keywordScore,
                topicMatchCount,
                topicWords.length,
                evidence,
            );

            if (confidence >= 50 && matchedKeywords.length > 0) {
                results.push({
                    evidence,
                    confidence,
                    matchedKeywords,
                });
            }
        }

        // 신뢰도 내림차순 정렬
        return results.sort((a, b) => b.confidence - a.confidence);
    }

    /**
     * Evidence 유효성 검증
     */
    private isEvidenceValid(evidence: VerifiedEvidence): boolean {
        // 활성화 여부
        if (!evidence.isActive) {
            return false;
        }

        // 날짜 유효성 (maxEvidenceAgeMonths 이내)
        const verifiedDate = new Date(evidence.verifiedDate);
        const maxAgeMs = this.config.maxEvidenceAgeMonths * 30 * 24 * 60 * 60 * 1000;
        if (Date.now() - verifiedDate.getTime() > maxAgeMs) {
            return false;
        }

        // 설문 참여자 수 검증 (large_survey인 경우)
        if (evidence.sourceType === 'large_survey') {
            if (!evidence.participantCount || evidence.participantCount < this.config.minSurveyParticipants) {
                return false;
            }
        }

        return true;
    }

    /**
     * 키워드 가중치 계산
     */
    private getKeywordWeight(keyword: string): number {
        // 긴 키워드일수록 더 높은 가중치
        if (keyword.length >= 6) return 3;
        if (keyword.length >= 4) return 2;
        return 1;
    }

    /**
     * 신뢰도 계산
     */
    private calculateConfidence(
        matchedCount: number,
        keywordScore: number,
        topicMatchCount: number,
        totalTopicWords: number,
        evidence: VerifiedEvidence,
    ): number {
        let confidence = 0;

        // 키워드 매칭 점수 (최대 50점)
        confidence += Math.min(keywordScore * 10, 50);

        // 토픽 매칭 점수 (최대 30점)
        const topicRatio = topicMatchCount / Math.max(totalTopicWords, 1);
        confidence += topicRatio * 30;

        // 출처 신뢰도 보너스 (최대 20점)
        const sourceBonus = this.getSourceTypeBonus(evidence.sourceType);
        confidence += sourceBonus;

        // 최신성 보너스 (최대 5점)
        const ageInMonths = this.getAgeInMonths(evidence.verifiedDate);
        if (ageInMonths <= 6) confidence += 5;
        else if (ageInMonths <= 12) confidence += 3;

        return Math.min(Math.round(confidence), 100);
    }

    /**
     * 출처 유형별 보너스 점수
     */
    private getSourceTypeBonus(sourceType: string): number {
        switch (sourceType) {
            case 'standard_organization': return 20;  // OWASP, IETF 등
            case 'official_announcement': return 18;  // Google, AWS 등
            case 'large_survey': return 15;           // StackOverflow 등
            case 'academic_paper': return 15;         // 학술 논문
            case 'statistics_agency': return 12;      // Statista 등
            default: return 0;
        }
    }

    /**
     * 검증 날짜로부터 경과 월수 계산
     */
    private getAgeInMonths(verifiedDate: string): number {
        const date = new Date(verifiedDate);
        const now = new Date();
        const months = (now.getFullYear() - date.getFullYear()) * 12 +
            (now.getMonth() - date.getMonth());
        return months;
    }
}
