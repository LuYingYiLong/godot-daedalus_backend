export type PromptId = 
    | "godot.assistant"
    | "gdscript.reviewer"
    | "scene.architect"
    | "backend.helper";

export type PromptTemplate = {
    id: PromptId;
    name: string;
    description: string;
    path: string;
};

export const promptTemplates: Record<PromptId, PromptTemplate> = {
    "godot.assistant": {
        id: "godot.assistant",
        name: "Godot Assistant",
        description: "General Godot Development Assistant",
        path: "src/prompts/templates/godot-assistant.md"
    },
    "gdscript.reviewer": {
        id: "gdscript.reviewer",
        name: "GDScript Reviewer",
        description: "Reviews GDScript code for type safety and style issues",
        path: "src/prompts/templates/gdscript-reviewer.md"
    },
    "scene.architect": {
        id: "scene.architect",
        name: "Scene Architect",
        description: "Designs Godot scene structures following scene-first principles",
        path: "src/prompts/templates/scene-architect.md"
    },
    "backend.helper": {
        id: "backend.helper",
        name: "Backend Helper",
        description: "TypeScript backend development for the AI Runtime",
        path: "src/prompts/templates/backend-helper.md"
    },
};