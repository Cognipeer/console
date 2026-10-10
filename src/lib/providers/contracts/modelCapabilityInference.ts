/**
 * Which chat models take images, judged by the model id alone.
 *
 * A model record may carry an explicit answer (`metadata.capabilities.inputModalities`,
 * set in the Model Hub). Most do not, and defaulting every such chat model to
 * "text only" made an agent drop the images people attached to a model that reads
 * them perfectly well. So when nothing explicit is stored, a model whose id belongs
 * to a known vision family is taken to accept images. An explicit choice —
 * including "text only" — always wins over this table (`resolveModelCapabilities`).
 *
 * One table, here, next to the provider contracts that know the model families:
 * the capability resolver, the model forms (prefilled from it) and the tests all
 * read it. It is a default, not a promise: a family a provider ships without
 * vision, or a deployment name that hides the model, is fixed by setting the
 * model's input modalities, not by editing code.
 */

export interface VisionFamilyRule {
    /** Shown in tests and logs; says which family matched. */
    family: string;
    /** Matches a normalised model id (see `normalizeModelIdForInference`). */
    match: RegExp;
    /** Members of the family that do NOT take images. */
    except?: RegExp;
}

export const VISION_MODEL_FAMILIES: readonly VisionFamilyRule[] = [
    // OpenAI. GPT-5 and later are multimodal as a rule; `gpt-oss` (open weights) is text only and does not match.
    { family: 'openai-gpt-4o', match: /^(?:chat)?gpt-4o/ },
    { family: 'openai-gpt-4.1-4.5', match: /^gpt-4\.[15]/ },
    { family: 'openai-gpt-4-turbo-vision', match: /^gpt-4-(?:turbo|vision)/, except: /^gpt-4-turbo-preview/ },
    { family: 'openai-gpt-5+', match: /^gpt-(?:[5-9]|1\d)(?:[.-]|$)/ },
    { family: 'openai-o1', match: /^o1/, except: /^o1-(?:mini|preview)/ },
    { family: 'openai-o3', match: /^o3/, except: /^o3-mini/ },
    { family: 'openai-o4', match: /^o4/ },
    // Anthropic: Claude 3 and everything after it; Claude 2 and Instant are text only.
    { family: 'anthropic-claude-3+', match: /^claude-(?:[3-9]|1\d)/ },
    { family: 'anthropic-claude-named', match: /^claude-(?:opus|sonnet|haiku)-\d/ },
    // Google.
    { family: 'google-gemini', match: /^gemini-/, except: /^gemini-(?:pro$|1\.0-pro(?!-vision))|embedding|-tts/ },
    // Meta (and the open runtimes that serve it).
    { family: 'meta-llama-3.2-vision', match: /^llama-?v?3[.p-]2-(?:(?:\d+b-)?(?:instruct-)?vision|11b|90b)/ },
    { family: 'meta-llama-4', match: /^llama-?4/ },
    { family: 'llava', match: /^(?:bak)?llava/ },
    // Alibaba / open vision-language models.
    { family: 'qwen-vl', match: /^(?:qwen|qvq)[\w.-]*vl|^qvq/ },
    { family: 'glm-v', match: /^glm-4\.?\d*v/ },
    { family: 'internvl', match: /^internvl/ },
    { family: 'deepseek-vl', match: /^deepseek-vl/ },
    { family: 'minicpm-v', match: /^minicpm-v/ },
    { family: 'molmo', match: /^molmo/ },
    { family: 'microsoft-phi-vision', match: /^phi-(?:3(?:\.5)?-vision|4-multimodal)/ },
    // Mistral.
    { family: 'mistral-pixtral', match: /^pixtral/ },
    { family: 'mistral-vision', match: /^mistral-(?:small|medium|large)-[\w.-]*vision|^mistral-small-3\.[1-9]|^mistral-medium-3/ },
    // xAI.
    { family: 'xai-grok-vision', match: /^grok-[\w.-]*vision|^grok-4/ },
    // Amazon Nova (Micro is text only).
    { family: 'amazon-nova', match: /^nova-(?:pro|lite|premier)/ },
];

const REGION_PREFIX = /^(?:us|eu|apac|us-gov|global)\./;
const VENDOR_PREFIX = /^(?:anthropic|amazon|meta|mistral|cohere|ai21|deepseek|qwen|openai|google|writer)\./;

/**
 * The model id the table is matched against: lower-cased, without a path
 * (`openai/gpt-4o`, `models/gemini-1.5-pro`, `accounts/x/models/llama-…`) and
 * without a Bedrock region / vendor prefix (`us.anthropic.claude-3-…`).
 */
export function normalizeModelIdForInference(modelId: string): string {
    const base = modelId.trim().toLowerCase().split('/').pop() ?? '';
    return base.replace(REGION_PREFIX, '').replace(VENDOR_PREFIX, '');
}

/** The family a model id belongs to when it is a known vision family, else null. */
export function matchVisionModelFamily(modelId: string | undefined | null): VisionFamilyRule | null {
    if (!modelId) return null;
    const id = normalizeModelIdForInference(modelId);
    if (!id) return null;
    for (const rule of VISION_MODEL_FAMILIES) {
        if (rule.match.test(id) && !rule.except?.test(id)) return rule;
    }
    return null;
}

/** Whether a chat model with no explicit setting is taken to accept images. */
export function inferModelAcceptsImages(modelId: string | undefined | null): boolean {
    return matchVisionModelFamily(modelId) !== null;
}
