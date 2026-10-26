export type Turn = {
  text: string
  guide?: "running" | "stopped" | "none"
  after?: "pause" | "complete"
  same_run?: boolean
  new_run?: boolean
  recipe?: boolean
  replan?: "adapt" | "replace_reference" | "keep" | "change_dish"
  servings?: number
}
export type Scenario = {
  id: string
  turns: Turn[]
  library?: "empty"
  max_questions: number
  intent?: "names" | "knowledge" | "direct_knowledge" | "web" | "clarify"
  memory?: boolean
  web_unavailable?: boolean
  stock_only?: boolean
  dish?: string
  legacy?: boolean
}

export const cases: Scenario[] = [
  {
    id: "replan-existing-reference",
    max_questions: 0,
    turns: [
      { text: "给我西红柿炒鸡蛋的两人份做法，油盐糖和常见调料都有，先看菜谱", recipe: true },
      { text: "不吃甜的，糖去掉，少放一点油，其他先不改", replan: "adapt", recipe: true },
      { text: "等一下，刚才为什么要先把鸡蛋盛出来？只解释，不要改菜谱", replan: "keep" },
      {
        text: "现在改成四个人吃，仍然不要糖、少油，沿用刚才那份参考改就行，先别开始",
        replan: "adapt",
        servings: 4,
        recipe: true,
        guide: "none",
      },
      { text: "就按这个四人份开始教我吧", guide: "running", servings: 4 },
    ],
  },
  {
    id: "replan-replace-reference",
    max_questions: 0,
    turns: [
      { text: "先给我西红柿炒鸡蛋的标准菜谱，常见材料都有，不用个性化，也不开始做", recipe: true },
      {
        text: "同一道菜，别用刚才那份资料了，帮我上网重新找一份参考菜谱，用新来源替换原参考，先不要个性化，不要开始做",
        replan: "replace_reference",
        recipe: true,
        guide: "none",
      },
    ],
  },
  {
    id: "new-recommendations",
    intent: "names",
    max_questions: 0,
    turns: [
      { text: "两个鸡蛋三个西红柿，给我推荐一道菜，只要菜名" },
      { text: "再推荐一道不一样的，别重复刚才那个，还是只要菜名" },
    ],
  },
  {
    id: "disordered-emotional",
    max_questions: 0,
    turns: [
      {
        text: "我是北京人，今天有点想家了。冰箱俩鸡蛋、三个西红柿，油盐都有，不想吃甜的，也别整复杂的。你帮我定一道，先看菜谱不开始",
        guide: "none",
        recipe: true,
      },
      { text: "这个可以，开始教我吧", guide: "running" },
    ],
  },
  {
    id: "general-cooking-question",
    intent: "direct_knowledge",
    max_questions: 0,
    turns: [{ text: "为什么西红柿炒鸡蛋一般先炒蛋再盛出来？我只是问原理，今天不做菜" }],
  },
  {
    id: "legacy-session-recovery",
    legacy: true,
    max_questions: 0,
    turns: [
      {
        text: "继续上次保存的 recipe_legacy_cooking_eval：两个鸡蛋三个西红柿，不加糖，用老抽，不去皮。别再问我水和老抽先放哪个了，这些你决定，直接带我做",
        guide: "running",
      },
    ],
  },
  {
    id: "blocked-evidence",
    library: "empty",
    web_unavailable: true,
    max_questions: 0,
    turns: [
      {
        text: "请找有可靠出处的西红柿炒鸡蛋菜谱，只能用实际读到的资料。查不到就告诉我，别编草稿，也不要开始引导",
        guide: "none",
      },
    ],
  },
  {
    id: "inventory-constraint",
    stock_only: true,
    max_questions: 0,
    turns: [
      { text: "只有两个鸡蛋三个西红柿，调料只有食用油和盐，其他材料都不能加，也不加水。给我一份能做的菜谱" },
      { text: "好，就按这个来，开始全程引导", guide: "running" },
    ],
  },
  {
    id: "changed-dish",
    dish: "汤",
    max_questions: 0,
    turns: [
      { text: "两个鸡蛋三个西红柿，先给我西红柿炒鸡蛋的做法" },
      { text: "不想炒了，换成西红柿鸡蛋汤，还是这些食材，油盐和水都有", replan: "change_dish" },
      { text: "好，带我做这个汤", guide: "running" },
    ],
  },
  {
    id: "identity-replan",
    max_questions: 0,
    turns: [
      { text: "你是谁" },
      { text: "我有两个鸡蛋，三个西红柿，给我推荐一道菜品" },
      { text: "好的，我需要西红柿炒鸡蛋的详细食谱" },
      { text: "这些调料我都有，但是我不想吃甜口的，我想加酱油，吃咸口的" },
      { text: "好的，带我一步一步做，我的酱油是老抽", guide: "running" },
    ],
  },
  {
    id: "names-only",
    max_questions: 0,
    intent: "names",
    turns: [{ text: "鸡蛋两个西红柿三个，先给我三个菜名就行，不用详细做法" }],
  },
  {
    id: "matching-reference",
    max_questions: 0,
    turns: [{ text: "给我西红柿炒鸡蛋的标准做法，先看资料，不用个性化，也先别启动引导", guide: "none" }],
  },
  {
    id: "successive-corrections",
    max_questions: 0,
    turns: [
      { text: "西红柿炒鸡蛋，两个鸡蛋三个西红柿，油盐糖都有，普通铁锅，给我做法" },
      { text: "等等，我不想吃甜口，糖去掉，加一点老抽" },
      { text: "再改一下，老抽也不要了，就用盐，油少一点，鸡蛋要嫩" },
      { text: "现在就是这个版本，开始一步一步带我做", guide: "running" },
    ],
  },
  {
    id: "resume-intent",
    max_questions: 0,
    turns: [
      {
        text: "两个鸡蛋三个西红柿，帮我定个家常炒蛋菜谱，然后直接开全程引导，我同意开始",
        guide: "running",
        after: "pause",
      },
      { text: "刚才退出界面了，把刚才那个打开，接着带我做", guide: "running", same_run: true },
    ],
  },
  {
    id: "stop-and-restart",
    max_questions: 0,
    turns: [
      { text: "帮我用两个鸡蛋三个西红柿炒一道菜，定好菜谱就开始引导，我要跟着做", guide: "running" },
      { text: "算了现在不想做了，这次结束吧", guide: "stopped" },
      { text: "又想做了，食材都没动，刚才还没操作，重新开一次引导", guide: "running", new_run: true },
    ],
  },
  {
    id: "recipe-decisions",
    max_questions: 0,
    turns: [
      {
        text: "给我西红柿炒鸡蛋的菜谱，2个蛋3个西红柿，只有老抽没有生抽，不加糖，其他常见调料都有。用量、先后顺序和火候你来定",
      },
      { text: "可以，教我做", guide: "running" },
    ],
  },
  {
    id: "knowledge-question",
    max_questions: 0,
    intent: "knowledge",
    turns: [{ text: "先查你们知识库，再解释为什么西红柿炒鸡蛋一般先炒蛋再盛出来？我只是问原理，今天不做菜" }],
  },
  {
    id: "explicit-web",
    max_questions: 0,
    intent: "web",
    turns: [{ text: "帮我去网上搜红烧肉不同的做法，比较一下，先别生成我的菜谱" }],
  },
  {
    id: "empty-library-draft",
    max_questions: 0,
    library: "empty",
    turns: [
      { text: "不要联网，给我西红柿炒鸡蛋的家常做法。资料库没有的话，可以用常识写，但要标明是未核验草稿" },
      { text: "可以，按这份带我做", guide: "running" },
    ],
  },
  {
    id: "essential-clarification",
    max_questions: 1,
    intent: "clarify",
    turns: [{ text: "帮我准备一桌宴席，不过人数和预算你先问我，别自己假设" }],
  },
  {
    id: "feedback-memory",
    max_questions: 0,
    memory: true,
    turns: [
      {
        text: "2个鸡蛋3个西红柿，盐和老抽都有，不放糖，定好菜谱直接开引导，我同意开始",
        guide: "running",
        after: "complete",
      },
      { text: "这次鸡蛋有点老，酱油味太重了" },
      { text: "下次还是做西红柿炒鸡蛋，按这次的反馈调整配方，先给我看看" },
    ],
  },
]
