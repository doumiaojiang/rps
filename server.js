const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const punishment = require('./punishment');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  // 生产环境反向代理（Nginx / 宝塔等）WebSocket 支持
  transports: ['websocket', 'polling']
});

// 全局错误捕获，防止服务器直接炸掉
process.on('uncaughtException', (err) => {
  console.error('【严重错误】uncaughtException:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('【严重错误】unhandledRejection:', reason);
});

app.use(express.static(path.join(__dirname, 'public')));

// ============ In-memory State ============
const playerStats = new Map();   // guestId -> { guestId, nickname, wins, losses, draws, played }
const tables = new Map();        // tableId -> Table
const onlineSockets = new Map(); // socket.id -> { guestId, nickname, tableId: string|null }

// 计时器相关 Map
const punishmentTicks = new Map();  // tableId -> intervalId (惩罚显示tick)
const lastQuickMsg = new Map();     // socket.id -> timestamp (快速消息防刷)

let matchHistory = [];           // recent finished rounds, newest first
let punishmentHistory = [];      // recent completed punishments for lobby display
let feedbacks = [];              // 留言板反馈（bug + 建议），最多保留20条
let totalRoundsPlayed = 0;

const feedbackCooldown = new Map(); // guestId -> 上次发送时间戳（1分钟限制）

// ============ Friend System ============
const friendRequests = new Map(); // toGuestId -> Array<{from, ts}>
const friendships = new Set();    // "g1#g2" sorted
const privateChats = new Map();   // "g1#g2" sorted -> Array<{from, to, message, ts}>
const privateChatUnread = new Map(); // guestId -> Map<fromId, count>

function getFriendshipKey(a, b) {
  return a < b ? `${a}#${b}` : `${b}#${a}`;
}

function getFriendList(guestId) {
  const list = [];
  for (const key of friendships) {
    const [ida, idb] = key.split('#');
    if (ida === guestId || idb === guestId) {
      const fid = ida === guestId ? idb : ida;
      const p = playerStats.get(fid);
      const online = Array.from(onlineSockets.values()).some(o => o.guestId === fid);
      list.push({
        guestId: fid,
        nickname: p ? p.nickname : '未知',
        gender: p ? p.gender : 'male',
        genderLabel: p ? p.genderLabel : null,
        nameBattlePrefix: p ? (p.nameBattlePrefix || '') : '',
        nameBattleScore: p ? (p.nameBattleScore || 0) : 0,
        nameBattleCode: p ? (p.nameBattleCode || '') : '',
        online
      });
    }
  }
  // online first
  list.sort((a, b) => (b.online === a.online) ? 0 : (b.online ? 1 : -1));
  return list;
}

function getPendingRequests(guestId) {
  const reqs = friendRequests.get(guestId) || [];
  return reqs.map(r => {
    const p = playerStats.get(r.from);
    return {
      from: r.from,
      nickname: p ? p.nickname : '未知',
      gender: p ? p.gender : 'male',
      genderLabel: p ? p.genderLabel : null,
      nameBattlePrefix: p ? (p.nameBattlePrefix || '') : '',
      nameBattleScore: p ? (p.nameBattleScore || 0) : 0,
      nameBattleCode: p ? (p.nameBattleCode || '') : '',
      ts: r.ts
    };
  });
}

function addPrivateMessage(from, to, message) {
  const key = getFriendshipKey(from, to);
  if (!privateChats.has(key)) privateChats.set(key, []);
  const arr = privateChats.get(key);
  arr.push({ from, to, message: String(message).slice(0, 280), ts: Date.now() });
  if (arr.length > 100) arr.shift();
}

function getPrivateHistory(guestId, friendId) {
  const key = getFriendshipKey(guestId, friendId);
  return (privateChats.get(key) || []).slice(-50);
}

function clearUnread(guestId, fromId) {
  const map = privateChatUnread.get(guestId);
  if (map) {
    map.delete(fromId);
    if (map.size === 0) privateChatUnread.delete(guestId);
  }
}

function incUnread(to, from) {
  if (!privateChatUnread.has(to)) privateChatUnread.set(to, new Map());
  const map = privateChatUnread.get(to);
  map.set(from, (map.get(from) || 0) + 1);
}

function getUnreadCounts(guestId) {
  const map = privateChatUnread.get(guestId);
  if (!map) return {};
  const obj = {};
  for (const [k, v] of map.entries()) obj[k] = v;
  return obj;
}

// ==================== 短小色情房间名生成器 ====================
// 目标：3~6字为主，色情但语句通顺，五花八门
const ROOM_ADJ = [
  "羞耻", "淫荡", "下贱", "变态", "禁忌", "堕落", "公开", "专属", "残酷", "极致",
  "恶心", "肮脏", "下流", "淫贱", "无耻", "卑微", "恶劣", "猥琐", "下作", "淫靡",
  "公共", "集体", "多人", "轮流", "免费", "随意", "无限制", "24小时", "永久"
];
const ROOM_OBJ = [
  "肉奴", "母狗", "精奴", "犬奴", "穴奴", "肉便", "玩物", "鸡奴",
  "肉便器", "精液容器", "公共马桶", "泄殖腔", "精液便池", "人类垃圾", "尿道玩具",
  "肉厕所", "精液回收站", "公共精盆"
];
const ROOM_ACT = [
  "调教", "玩弄", "灌精", "羞辱", "榨精", "侵犯", "训练",
  "肉便使用", "公共轮奸", "无套内射", "精液涂抹", "后庭扩张", "深喉训练",
  "体液涂鸦", "自拍记录", "暴露展示"
];
const ROOM_PLACE = [
  "间", "室", "房", "笼", "舍", "营", "所",
  "交配室", "繁殖间", "肉便池", "精液厕所", "公共使用室", "肉便器营",
  "泄殖腔舍", "调教监狱", "羞辱展厅", "永久标记室"
];

// 普通战斗房间名（无惩罚风格时使用，区分18x重口房间）
const NORMAL_ADJ = ["激烈", "高手", "随机", "经典", "快速", "公平", "刺激", "巅峰", "对决", "竞技", "热血", "极限"];
const NORMAL_OBJ = ["对战", "擂台", "决斗", "对局", "挑战", "竞技", "对决", "对战"];
const NORMAL_PLACE = ["室", "场", "间", "厅", "区", "台", "营"];

// 惩罚风格专属词库（公共池 + 专属池设计）
// 当选择对应惩罚风格时，会优先从专属池抽取，产生高度匹配的房间名
const STYLE_SPECIFIC_POOLS = {
  // 黑人/种族play专属（绝不混入其他风格）
  blacked: {
    adj: ["媚黑", "黑人专用", "BBC", "大黑屌", "非洲野兽", "黑种", "种族", "白皮肉便", "黑爹的", "黑屌奴隶", "白人劣等", "黑人繁殖", "BBC标记", "黑种献祭", "种族肉穴", "黑爹专属"],
    obj: ["黑奴", "黑肉便器", "白母猪", "黑爹肉穴", "BBC精液容器", "黑人精巢", "种族肉便", "黑种母狗", "白皮肉便器", "黑人精盆", "黑爹专用穴", "种族交配犬", "黑屌肉套", "非洲种马的玩具", "黑人泄欲器"],
    act: ["黑人灌精", "BBC侍奉", "种族羞辱", "黑爹调教", "黑种标记", "媚黑繁殖", "黑屌使用", "白皮献祭", "黑人轮奸", "BBC内射", "种族灭绝性交", "黑爹精液涂满全身", "黑种妊娠", "白母猪跪舔黑屌", "黑人征服"],
    place: ["交配室", "黑人后宫", "BBC专用间", "种族调教室", "黑爹繁殖舍", "白母猪营", "黑种标记室", "黑人精液池", "种族灭绝间", "黑爹后宫", "黑人征服营"]
  },

  // 肉便器/公共使用专属
  meat_toilet: {
    adj: ["公共", "无限制", "多人", "集体", "免费", "随意使用", "24小时", "永久", "无差别", "轮流", "垃圾级", "下水道级", "公共泄欲"],
    obj: ["肉便器", "精液便池", "公共马桶", "泄殖腔", "精液容器", "肉厕所", "人类垃圾", "尿道玩具", "精液回收站", "公共肉穴", "下水道肉便", "精液便池专用", "公共精盆"],
    act: ["公共使用", "轮流灌精", "无套内射", "精液涂抹", "后庭扩张", "口交+肛交", "体液标记", "免费使用", "多人轮奸", "精液淋浴", "全孔使用", "垃圾处理", "下水道清洗", "公共泄欲"],
    place: ["肉便池", "精液厕所", "公共使用间", "肉便器营", "泄殖腔舍", "精液回收站", "永久肉便室", "公共精液池", "下水道肉便间", "24小时肉便营", "公共泄欲室"]
  },

  // 暴露/公开羞辱专属
  expose: {
    adj: ["暴露", "公开", "窗边", "阳台", "门口", "大庭广众", "全城", "直播", "街头", "全裸", "无遮挡", "高空", "公开献丑"],
    obj: ["暴露母狗", "公开肉奴", "窗边肉便", "阳台精奴", "街头肉穴", "全城肉便器", "直播肉便", "高空肉穴", "公开献丑犬"],
    act: ["暴露展示", "窗边自慰", "阳台写字", "门口告白", "直播使用", "全城巡游", "街头自拍", "高空暴露", "无遮挡使用", "全裸游街", "公开献丑"],
    place: ["暴露间", "窗边展示室", "阳台肉便舍", "公开调教室", "街头使用营", "直播间", "高空暴露台", "全城展示营", "公开献丑室"]
  },

  // 强制记录/证据专属
  record: {
    adj: ["强制记录", "永久存档", "证据", "自拍", "录像", "不可删除", "全网", "云端", "备份", "流传", "耻辱档案", "永久证据"],
    obj: ["记录肉奴", "证据母狗", "自拍精奴", "永久肉便", "耻辱证据", "全网肉穴", "云端肉便器", "耻辱档案犬"],
    act: ["强制自拍", "录像使用", "证据标记", "永久存档", "全网流传", "云端备份", "直播录制", "耻辱视频", "全过程拍摄", "永久留证"],
    place: ["记录室", "证据存档间", "自拍调教室", "永久标记舍", "耻辱档案室", "全网流传间", "云端肉便营", "永久证据间"]
  },

  // 语言羞辱专属
  verbal: {
    adj: ["语言", "下贱告白", "自我羞辱", "详细身体", "长篇", "最下贱", "无下限", "极端自辱", "详细身体描写", "自我贬低"],
    obj: ["告白肉奴", "羞辱母狗", "语言精奴", "自辱肉便", "下贱告白犬", "自我贬低器"],
    act: ["自我羞辱", "详细告白", "下贱自报", "长篇身体羞辱", "最下贱表白", "无下限自辱", "详细器官描写", "极端自报家门", "自我贬低"],
    place: ["告白间", "羞辱室", "语言调教室", "下贱告白舍", "自辱录音室", "长篇羞辱间", "自我贬低室"]
  },

  // 重度SM专属
  heavy: {
    adj: ["重度", "残酷", "极端", "无下限", "血腥", "重口", "极致", "虐待级", "毁灭性", "无情", "残暴"],
    obj: ["重口肉便", "极端母狗", "残酷精奴", "无下限肉穴", "虐待肉玩具", "毁灭级肉便", "残暴玩具"],
    act: ["重度打骂", "极端姿势", "血腥羞辱", "无下限使用", "极致折磨", "虐待级使用", "毁灭性玩弄", "无情摧残", "残暴调教"],
    place: ["重口调教室", "极端使用间", "残酷肉便营", "无下限监狱", "虐待专用室", "毁灭级调教室", "残暴折磨间"]
  },

  // 纹身/永久标记专属
  tattoo: {
    adj: ["纹身", "永久标记", "刺青", "羞耻文字", "身体涂鸦", "耻辱刺青", "不可洗", "全身", "多部位", "永久耻辱"],
    obj: ["纹身肉奴", "刺青母狗", "标记精奴", "身体肉便", "耻辱刺青犬", "永久文字肉穴", "耻辱画布"],
    act: ["强制纹身", "耻辱刺青", "身体标记", "永久文字", "多部位涂鸦", "全身耻辱刺青", "不可洗标记", "耻辱刺青"],
    place: ["纹身室", "标记间", "刺青调教室", "永久耻辱舍", "身体涂鸦营", "耻辱刺青室", "永久标记间"]
  },

  // 聊天室宠物羞辱 v1.0 轻度 专属词库（房间名生成用）
  fantasy: {
    adj: ["聊天室", "公开", "宠物", "羞辱", "自辱", "贱名", "调教", "摇尾巴", "学叫", "跪姿", "宠物扮演", "信息暴露", "自报", "畜生化"],
    obj: ["小母狗", "小公狗", "小雌犬", "母畜", "公畜", "雌畜", "聊天宠物", "自辱奴", "宠物奴", "贱畜", "信息暴露犬"],
    act: ["公开自辱", "聊天告白", "宠物学叫", "摇尾巴表演", "信息暴露", "畜生训练", "自报家门", "跪姿展示", "宠物扮演"],
    place: ["聊天室", "宠物舍", "羞辱间", "自报室", "调教室", "暴露台", "跪姿间", "畜生营", "宠物调教间"]
  },

  // 聊天室宠物羞辱 v1.0 中度 专属词库
  fantasy_medium: {
    adj: ["宠物化", "精神调教", "自我暴露", "中度羞辱", "渐进畜生", "聊天室宠物", "自我物化", "过程暴露"],
    obj: ["宠物化母畜", "精神公畜", "自我暴露雌畜", "渐进贱畜", "聊天室宠物奴", "中度物化犬"],
    act: ["宠物化过程", "精神调教", "自我暴露", "渐进畜生化", "聊天室长篇自辱", "中度信息暴露"],
    place: ["宠物化间", "精神调教室", "自我暴露舍", "渐进畜生营", "聊天室自辱间", "中度物化室"]
  },

  // 聊天室宠物羞辱 v1.0 重度 专属词库（极端信息暴露 + 彻底畜生化）
  pet_heavy: {
    adj: ["彻底", "永久", "真实姓名", "每日畜生", "完全物化", "极端自辱", "全信息暴露", "永久宠物", "彻底贱畜"],
    obj: ["彻底母畜", "永久公畜", "真实姓名雌畜", "每日畜生", "完全物化贱畜", "极端自辱奴", "全信息暴露犬"],
    act: ["真实姓名暴露", "每日畜生报告", "彻底物化", "永久宠物化", "全信息自报", "极端自辱告白", "畜生日常展示"],
    place: ["彻底畜生舍", "永久宠物营", "真实姓名暴露间", "每日报告室", "完全物化间", "极端自辱舍"]
  },

  // 轻度专属（温柔/可爱羞辱）
  light: {
    adj: ["轻度", "温柔羞辱", "可爱调教", "轻柔", "小恶作剧", "可爱肉便", "粉嫩", "可爱羞耻", "轻微"],
    obj: ["可爱肉奴", "轻柔母狗", "羞耻玩物", "小恶作剧肉便", "粉嫩玩具", "可爱宠物"],
    act: ["轻柔调教", "可爱羞辱", "小恶作剧使用", "温柔灌精", "可爱姿势", "轻微羞辱", "可爱命令"],
    place: ["轻度调教室", "可爱肉便间", "羞耻小游戏室", "温柔使用舍", "粉嫩调教间", "可爱羞辱室"]
  },

  // 中度专属
  medium: {
    adj: ["中度", "适中羞辱", "平衡调教", "中等强度", "半公开", "适度", "进阶"],
    obj: ["中度肉便", "平衡母狗", "适中精奴", "半公开肉穴", "中等玩具", "进阶肉便"],
    act: ["中等强度使用", "平衡调教", "半公开羞辱", "中度灌精", "适中扩张", "进阶羞辱"],
    place: ["中度调教室", "平衡使用间", "半公开肉便营", "适中强度舍", "中等调教间", "进阶使用室"]
  },

  // 以下为性器官/玩法专属，严格区分
  anal: {
    adj: ["后庭", "肛门", "菊花", "直肠", "后穴", "肛交专用", "无润滑", "扩张级", "屁眼", "后门"],
    obj: ["肛奴", "后庭肉套", "直肠肉便", "菊花精奴", "肛门肉穴", "扩张肉便器", "屁眼玩具", "后门肉便"],
    act: ["后庭扩张", "肛交使用", "直肠灌精", "无润滑肛交", "菊花调教", "肛门标记", "屁眼开发", "后门征服"],
    place: ["肛门使用间", "后庭扩张室", "直肠肉便舍", "菊花调教室", "肛交专用营", "屁眼开发间", "后门调教室"]
  },

  oral: {
    adj: ["口腔", "嘴部", "喉穴", "吞精", "嘴奴"],
    obj: ["口奴", "喉奴", "嘴穴玩具", "吞精容器", "口腔肉便"],
    act: ["口腔使用", "强制口交", "喉咙侍奉", "嘴部开发", "吞精训练"],
    place: ["口交室", "喉奴间", "吞精调教室", "嘴穴营", "口腔使用间"]
  },

  deepthroat: {
    adj: ["深喉", "喉穴", "气管", "食道", "窒息"],
    obj: ["喉奴", "深喉容器", "气管玩具", "食道肉便", "喉咙奴"],
    act: ["深喉训练", "喉部征服", "气管扩张", "强制深喉", "食道使用"],
    place: ["深喉室", "喉奴营", "气管调教室", "食道开发间", "窒息训练室"]
  },

  edging: {
    adj: ["寸止", "边缘", "绝望", "崩坏"],
    obj: ["寸止犬", "边缘玩具", "绝望母狗", "崩坏容器"],
    act: ["寸止", "边缘控制", "高潮剥夺", "绝望折磨"],
    place: ["寸止室", "边缘营", "绝望控制间", "崩坏教室"]
  },

  sex: {
    adj: ["阴道", "子宫", "内射", "繁殖", "无套"],
    obj: ["子宫肉杯", "阴道容器", "繁殖母狗", "内射玩具"],
    act: ["无套内射", "子宫使用", "繁殖调教", "大量灌精", "子宫征服"],
    place: ["子宫室", "繁殖调教室", "内射专用间", "阴道开发营", "子宫征服室"]
  }
};

// ==================== 名字争夺战 前缀系统 ====================
// 正向：SM化主人/女王/雌主系 + 性别区分
// 负向：按 通用 + 对应性别区 抽取（随机后固定，直到掉级）
// -200以下：只显示代号 SLAVE-XXXX，隐藏真实名字

// 负分称号池（按性别分类）
const NEGATIVE_GENERAL = [
  '贱人', '奴才', '跪舔者', '杂鱼', '下等货', '贱奴', '肉便器', '精液容器',
  '公共马桶', '泄殖腔', '精液泄殖腔', '双穴废物', '肉便器专用', '精液回收站',
  '人类排泄物', '活体便器', '无用肉便器', '精液便器', '彻底贱畜', '无名贱畜',
  '连名字都不配有的东西', '精液肉便器', '永久肉便器', '下贱肉便器', '无脑精奴',
  '公共泄欲器', '连体玩具', '尿壶', '舔鞋器', '公用玩具', '精奴',
  '精盆', '肉垫', '泄欲器', '精液桶', '公共器具', '肉玩具', '精液马桶', '性爱便器'
];

const NEGATIVE_MALE = [
  '走狗', '公狗', '精奴', '泄殖腔'
];

const NEGATIVE_FEMALE = [
  '母畜', '雌畜', '母狗', '公用肉穴', '穴奴', '只会叫的母狗', '彻底的雌畜',
  '只会高潮的母狗', '双穴废物'
];

const NEGATIVE_FEMBOY = [
  '肉便预备', '精奴', '连体玩具', '尿壶', '舔鞋器', '肉便器', '精液肉便器',
  '下贱肉便器', '无脑精奴', '只会叫的母狗', '公用玩具', '母狗'
];

const NAME_BATTLE_TIERS = [
  // 正分上位（SM化主人系 + 性别区分）
  { min: 120, label: '顶级支配', prefixes: ['至高女王', '女皇', '永恒女主', '至高无上的主人', '绝对主人', '至高雌主', '男娘女王'] },
  { min: 80, label: '高级支配', prefixes: ['女王', '女主人', '严父', '调教爸爸', '训奴师', '雌主', '男娘主人'] },
  { min: 50, label: '中高级支配', prefixes: ['女主人', '主人', '调教师', '男娘主'] },
  { min: 20, label: '中级支配', prefixes: ['女上位者', '上位者', '男娘上位'] },
  { min: 5, label: '轻度支配', prefixes: ['女士', '先生', '男娘'] },
  { min: 0, label: '', prefixes: [''] },

  // 负分下位（实际从分类池抽取，下面 prefixes 仅用于 label 展示）
  { min: -20, label: '轻度下贱', prefixes: [] },
  { min: -50, label: '中度下贱', prefixes: [] },
  { min: -80, label: '重度下贱', prefixes: [] },
  { min: -120, label: '极重度', prefixes: [] },
  { min: -200, label: '无名贱畜', prefixes: ['无名贱畜'] },  // 固定
  { min: -999, label: '代号模式', prefixes: [] }
];

const NAME_BATTLE_SCORE_MAX = 999;
const NAME_BATTLE_SCORE_MIN = -999;

function clampNameBattleScore(score) {
  const s = Number(score) || 0;
  return Math.max(NAME_BATTLE_SCORE_MIN, Math.min(NAME_BATTLE_SCORE_MAX, s));
}


function getNameBattleTier(score) {
  for (let i = 0; i < NAME_BATTLE_TIERS.length; i++) {
    if (score >= NAME_BATTLE_TIERS[i].min) {
      return i;
    }
  }
  return NAME_BATTLE_TIERS.length - 1;
}

/**
 * 名字争夺战积分难度系数（按用户要求）
 * - 低等级（负分越低）获取积分越少（爬分难度高），扣分不变
 * - 高等级（正分女王线）掉分越难（loss multiplier 越低）
 * 7级负分阶段示例：最差(-7级) gain 30%，次差 gain 40% 等
 */
function getNameBattleGainMultiplier(score) {
  const tier = getNameBattleTier(score);
  if (tier <= 5) return 1.0; // 正常人及以上：全额获取

  // 负分下位 7 个难度阶段（tier 6 ~ 11 映射到 level 1~7）
  // 等级越低（越差）gain 越低
  const negGainRates = [0.90, 0.80, 0.70, 0.60, 0.50, 0.40, 0.30];
  const negIndex = Math.min(tier - 6, negGainRates.length - 1);
  return negGainRates[negIndex];
}

function getNameBattleLossMultiplier(score) {
  const tier = getNameBattleTier(score);
  if (tier >= 6) return 1.0; // 负分及以下：扣分不变（全额）

  // 正分上位：等级越高（tier 越小，女王线）掉分越难
  const posLossRates = [0.30, 0.45, 0.60, 0.75, 0.90, 1.0]; // tier 0~5
  return posLossRates[tier];
}

function generateSlaveCode(guestId) {
  // 基于guestId生成稳定4位字母数字代码
  let hash = 0;
  for (let i = 0; i < guestId.length; i++) {
    hash = ((hash << 5) - hash) + guestId.charCodeAt(i);
    hash |= 0;
  }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  let n = Math.abs(hash);
  for (let i = 0; i < 4; i++) {
    code += chars[n % chars.length];
    n = Math.floor(n / chars.length);
  }
  return 'SLAVE-' + code;
}

// 获取当前应显示的前缀（带sticky逻辑）
function getNameBattlePrefix(player) {
  if (!player || !player.nameBattleEnabled) return '';

  const score = player.nameBattleScore || 0;
  const gender = player.gender || 'male';
  const currentTier = getNameBattleTier(score);

  // 0~4分强制为正常人（无任何前缀），无论之前是什么称号
  // 这样从正分掉到0或从负分升到0都会清空称号
  if (score >= 0 && score < 5) {
    player.nameBattlePrefix = '';
    player.nameBattlePrefixTier = currentTier;
    return '';
  }

  // 极低分（-200以下）：代号模式，只返回代号，不返回前缀
  if (score <= -200) {
    if (!player.nameBattleCode) {
      player.nameBattleCode = generateSlaveCode(player.guestId);
    }
    return ''; // 前缀为空，由显示层决定显示代号
  }

  const tierDef = NAME_BATTLE_TIERS[currentTier];

  // 只有跨入新的阶段（tier）时才会改变称号
  // 同一阶段内分数小幅波动不会导致称号乱跳
  const storedTier = (player.nameBattlePrefixTier !== undefined) ? player.nameBattlePrefixTier : -1;

  if (!player.nameBattlePrefix || currentTier !== storedTier) {
    let pool = tierDef.prefixes;

    // 正向称号性别区分逻辑（SM化主人系）
    if (currentTier <= 4) { // 正分上位
      if (gender === 'female') {
        const femalePool = pool.filter(p => p.includes('女王') || p.includes('女') || p.includes('女士'));
        if (femalePool.length > 0) pool = femalePool;
      } else if (gender === 'femboy') {
        const femboyPool = pool.filter(p => p.includes('雌主') || p.includes('男娘'));
        if (femboyPool.length > 0) pool = femboyPool;
      } else {
        // 男性过滤：严格排除女主/女王/雌主/男娘相关词，防止男的随机到女主人等
        const malePool = pool.filter(p => 
          !p.includes('女') && !p.includes('女王') && !p.includes('女士') && 
          !p.includes('雌主') && !p.includes('男娘') &&
          (p.includes('主人') || p.includes('爸爸') || p.includes('训奴师') || 
           p.includes('先生') || p.includes('上位'))
        );
        if (malePool.length > 0) pool = malePool;
      }
    } 
    // 负分称号：通用 + 对应性别区
    else {
      pool = [...NEGATIVE_GENERAL];

      if (gender === 'female') {
        pool = pool.concat(NEGATIVE_FEMALE);
      } else if (gender === 'femboy') {
        pool = pool.concat(NEGATIVE_FEMBOY);
      } else {
        pool = pool.concat(NEGATIVE_MALE);
      }

      // 去重
      pool = [...new Set(pool)];
    }

    const pick = pool[Math.floor(Math.random() * pool.length)] || '';
    player.nameBattlePrefix = pick;
    player.nameBattlePrefixTier = currentTier;
  }

  return player.nameBattlePrefix || '';
}

function applyNameBattleDecay(player) {
  if (!player || !player.nameBattleEnabled) return;

  const now = Date.now();
  const last = player.nameBattleLastDecay || now;
  const hours = Math.floor((now - last) / (1000 * 60 * 60));

  if (hours > 0) {
    const decay = hours * 3;
    player.nameBattleScore = clampNameBattleScore( (player.nameBattleScore || 0) - decay );
    player.nameBattleLastDecay = now;

    // 可能需要重新评估前缀
    if (player.nameBattleScore <= -200) {
      // 极端模式不需要前缀
    } else {
      getNameBattlePrefix(player);
    }
  }
}

/**
 * 获取玩家在系统消息中应该显示的名字（带名字争夺战前缀或代号）
 */
function getDisplayNameForPlayer(guestId) {
  const p = playerStats.get(guestId);
  if (!p) return '未知玩家';

  try {
    const prefix = getNameBattlePrefix(p);
    const code = p.nameBattleCode || '';

    if ((p.nameBattleScore || 0) <= -200 && code) {
      return code;
    }
    if (prefix) {
      return `${prefix} ${p.nickname || '未知'}`;
    }
    return p.nickname || '未知玩家';
  } catch (e) {
    console.error('getDisplayNameForPlayer error for', guestId, e);
    return p.nickname || '未知玩家';
  }
}

function enrichPlayerForClient(playerObj) {
  if (!playerObj) return null;
  const p = playerStats.get(playerObj.guestId);
  const prefix = p ? getNameBattlePrefix(p) : '';
  const code = p && p.nameBattleCode ? p.nameBattleCode : '';

  return {
    ...playerObj,
    nameBattlePrefix: prefix,
    nameBattleCode: code,
    nameBattleScore: p ? (p.nameBattleScore || 0) : 0
  };
}

function generateNormalRoomName() {
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const type = Math.floor(Math.random() * 5);
  switch (type) {
    case 0: return pick(NORMAL_ADJ) + pick(NORMAL_OBJ) + pick(NORMAL_PLACE);
    case 1: return pick(NORMAL_OBJ) + pick(NORMAL_PLACE);
    case 2: return pick(NORMAL_ADJ) + pick(NORMAL_PLACE);
    case 3: return pick(["激烈", "经典", "随机"]) + pick(NORMAL_OBJ) + pick(NORMAL_PLACE);
    default: return pick(NORMAL_ADJ) + pick(NORMAL_OBJ) + pick(NORMAL_PLACE);
  }
}

function generateEroticRoomName(punishmentStyle = 'none') {
  // 无惩罚风格时，使用普通战斗房间名（区分18x重口房间）
  if (!punishmentStyle || punishmentStyle === 'none') {
    return generateNormalRoomName();
  }

  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const hasStyle = STYLE_SPECIFIC_POOLS[punishmentStyle];
  const style = hasStyle ? STYLE_SPECIFIC_POOLS[punishmentStyle] : null;

  // 构建有效词池：公共池 + 专属池（专属池权重更高）
  const getPool = (common, styleExtra = []) => {
    if (!style || !styleExtra.length) return common;
    // 专属池词重复出现，提高被抽中概率
    return [...common, ...styleExtra, ...styleExtra];
  };

  const adjPool = getPool(ROOM_ADJ, style?.adj);
  const objPool = getPool(ROOM_OBJ, style?.obj);
  const actPool = getPool(ROOM_ACT, style?.act);
  const placePool = getPool(ROOM_PLACE, style?.place);

  // 简化生成逻辑：主要使用「修饰词 + 地方」的干净结构
  // 修饰词可以是形容词、名词或动词短语
  const getModifier = () => {
    const r = Math.random();
    if (r < 0.38) return pick(adjPool);
    if (r < 0.72) return pick(objPool);
    return pick(actPool);
  };

  const getPlace = () => pick(placePool);

  // 有风格时优先用专属词
  if (style) {
    // 85% 的概率使用简单干净结构（用户要求）
    if (Math.random() < 0.85) {
      return getModifier() + getPlace();
    }
    // 少数情况允许带“的”的结构，增加一点变化
    return pick(adjPool) + pick(objPool) + "的" + getPlace();
  }

  // 无风格（普通房间）
  if (Math.random() < 0.88) {
    return getModifier() + getPlace();
  }
  return pick(adjPool) + pick(objPool) + "的" + getPlace();
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 初始化惩罚模块（把依赖传进去）
punishment.init({
  tables,
  playerStats,
  io,
  addChat,
  broadcastTableUpdate,
  broadcastLobby,
  clearPunishmentTimer,
  punishmentTicks,
  punishmentHistory
});

// 惩罚列表已完全移到 punishment.js（50条轻度更涩 + 20条随机纹身贴 + 随机生成器）
// 旧列表已清理，避免语法冲突

function genId(prefix = '') {
  return prefix + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 7);
}

function getOrCreatePlayer(guestId, nickname, gender, genderLabel) {
  if (!guestId) guestId = genId('G');
  let p = playerStats.get(guestId);
  if (!p) {
    p = {
      guestId,
      nickname: nickname || '游客',
      gender: (gender === 'male' || gender === 'female' || gender === 'femboy') ? gender : 'male',
      genderLabel: genderLabel || null,
      wins: 0,
      losses: 0,
      draws: 0,
      played: 0,
      punishmentsReceived: 0,
      punishmentHistory: [],
      // ===== 名字争夺战字段 =====
      nameBattleEnabled: false,
      nameBattleScore: 0,
      nameBattlePrefix: '',
      nameBattlePrefixTier: 0,        // 用于判断是否需要重新抽前缀
      nameBattleCode: '',             // 极低分专用代号（SLAVE-XXXX）
      nameBattleLastDecay: Date.now(),
      nameBattleQuitLockUntil: 0      // 退出后改名锁定截止时间戳
    };
    playerStats.set(guestId, p);
  } else {
    if (nickname && nickname !== p.nickname) p.nickname = nickname;
    if (gender && (gender === 'male' || gender === 'female' || gender === 'femboy')) {
      p.gender = gender;
    }
    if (genderLabel) {
      p.genderLabel = genderLabel;
    }
    // 补齐新字段（兼容老玩家）
    if (typeof p.nameBattleEnabled === 'undefined') p.nameBattleEnabled = false;
    if (typeof p.nameBattleScore === 'undefined') p.nameBattleScore = 0;
    if (typeof p.nameBattlePrefix === 'undefined') p.nameBattlePrefix = '';
    if (typeof p.nameBattlePrefixTier === 'undefined') p.nameBattlePrefixTier = 0;
    if (typeof p.nameBattleCode === 'undefined') p.nameBattleCode = '';
    if (typeof p.nameBattleLastDecay === 'undefined') p.nameBattleLastDecay = Date.now();
    if (typeof p.nameBattleQuitLockUntil === 'undefined') p.nameBattleQuitLockUntil = 0;

    // 施加积分上下限（-999 ~ 999）
    p.nameBattleScore = clampNameBattleScore(p.nameBattleScore);
  }
  return p;
}

function updatePlayerResult(guestId, result) {
  // result: 'win' | 'loss' | 'draw'
  const p = playerStats.get(guestId);
  if (!p) return;
  p.played = (p.played || 0) + 1;
  if (result === 'win') p.wins = (p.wins || 0) + 1;
  else if (result === 'loss') p.losses = (p.losses || 0) + 1;
  else p.draws = (p.draws || 0) + 1;
}

function createTable(creator, customName, timeLimit = 0, punishmentStyles = [], password = null, gameSettings = {}, isNameBattleRoom = false, nameBattleBet = 0) {
  const tableId = genId('T');

  // 支持旧的单风格和新的多风格
  const stylesArray = Array.isArray(punishmentStyles) && punishmentStyles.length > 0 
    ? punishmentStyles 
    : (punishmentStyles ? [punishmentStyles] : ['none']);

  const allowed = ['none', 'fantasy', 'fantasy_medium', 'light', 'medium', 'heavy', 'tattoo', 'blacked', 'anal', 'oral', 'deepthroat', 'edging', 'sex', 'meat_toilet', 'record', 'expose', 'verbal', 'pain_v1', 'pet_heavy', 'nipple_loser_light', 'nipple_loser_medium', 'nipple_loser_heavy', 'motherbeast_light', 'motherbeast_medium', 'motherbeast_heavy'];

  const validStyles = stylesArray.filter(s => allowed.includes(s)).slice(0, 3);
  if (validStyles.length === 0) validStyles.push('none');

  // 默认游戏设置
  const settings = {
    mode: gameSettings.mode || 'unlimited',
    targetWins: gameSettings.targetWins || 0,
    maxRounds: gameSettings.maxRounds || 0,
    punishOnDraw: !!gameSettings.punishOnDraw
  };

  const table = {
    id: tableId,
    name: customName || generateEroticRoomName(validStyles[0] || 'none'),
    playerA: null,
    playerB: null,
    moves: {},
    round: 1,
    chat: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
    timeLimit: Number(timeLimit) || 0,
    remainingTime: 0,
    currentPunishment: null,
    spectators: [],
    password: password || null,
    gameSettings: settings,
    punishmentStyles: validStyles,   // 新：多风格数组
    // 兼容旧代码
    punishmentStyle: validStyles[0] || 'none',
    // ===== 名字争夺战房间专属字段 =====
    isNameBattleRoom: !!isNameBattleRoom,
    nameBattleBet: Number(nameBattleBet) || 0
  };
  tables.set(tableId, table);

  if (creator) {
    table.playerA = {
      guestId: creator.guestId,
      nickname: creator.nickname,
      gender: creator.gender || 'male',
      genderLabel: creator.genderLabel || null,
      score: 0
    };
  }
  return table;
}

function serializeTable(t, forPlayerGuestId = null) {
  const players = [];
  if (t.playerA) players.push({ seat: 'A', ...t.playerA });
  if (t.playerB) players.push({ seat: 'B', ...t.playerB });

  const myMove = forPlayerGuestId ? (t.moves[forPlayerGuestId] || null) : null;

  return {
    id: t.id,
    name: t.name,
    playerA: t.playerA ? enrichPlayerForClient(t.playerA) : null,
    playerB: t.playerB ? enrichPlayerForClient(t.playerB) : null,
    round: t.round,
    timeLimit: t.timeLimit || 0,
    remainingTime: t.remainingTime || 0,
    punishmentStyle: t.punishmentStyle || 'none',
    punishmentStyles: t.punishmentStyles || [t.punishmentStyle || 'none'],
    currentPunishment: t.currentPunishment || null,
    spectators: (t.spectators || []).map(s => ({ guestId: s.guestId, nickname: s.nickname, gender: s.gender || 'male' })),
    hasPassword: !!t.password,
    gameSettings: t.gameSettings || { mode: 'unlimited' },
    // ===== 名字争夺战房间专属字段 =====
    isNameBattleRoom: !!t.isNameBattleRoom,
    nameBattleBet: t.nameBattleBet || 0,
    movesStatus: {
      A: t.playerA ? !!t.moves[t.playerA.guestId] : false,
      B: t.playerB ? !!t.moves[t.playerB.guestId] : false
    },
    myMove,
    chat: t.chat.slice(-60)
  };
}

function getLobbyData() {
  const tableList = [];
  for (const t of tables.values()) {
    const seated = (t.playerA ? 1 : 0) + (t.playerB ? 1 : 0);
    tableList.push({
      id: t.id,
      name: t.name,
      seated,
      round: t.round,
      hasGame: seated === 2,
      punishmentStyle: t.punishmentStyle || 'none',
    punishmentStyles: t.punishmentStyles || [t.punishmentStyle || 'none'],
      hasPassword: !!t.password,
      gameSettings: t.gameSettings || { mode: 'unlimited' },
      // ===== 名字争夺战相关 =====
      isNameBattleRoom: !!t.isNameBattleRoom,
      nameBattleBet: t.nameBattleBet || 0,
      // 新增：房间名下方显示用（带完整性别标签用于彩色全称框）
      playerA: t.playerA ? enrichPlayerForClient(t.playerA) : null,
      playerB: t.playerB ? enrichPlayerForClient(t.playerB) : null,
      spectatorCount: (t.spectators || []).length
    });
  }
  tableList.sort((a, b) => b.seated - a.seated || a.name.localeCompare(b.name));

  const onlineCount = onlineSockets.size;

  // 在线名单（仅当前在线玩家 + 排名/胜率/被罚次数 + 胜败）
  const onlinePlayers = Array.from(onlineSockets.values())
    .map(info => {
      const p = playerStats.get(info.guestId) || {};
      const played = p.played || 0;
      const wins = p.wins || 0;
      const losses = p.losses || 0;
      const punish = p.punishmentsReceived || 0;
      // 胜利概率 = 胜场 / 总对局（含平局），更真实
      const winProb = played > 0 ? Math.round((wins / played) * 100) : 0;
      return {
        guestId: info.guestId,
        nickname: info.nickname || p.nickname || '游客',
        gender: info.gender || p.gender || 'male',
        genderLabel: info.genderLabel || p.genderLabel || null,
        wins,
        losses,
        played,
        punishmentsReceived: punish,
        winProb,
        // 名字争夺战
        nameBattleScore: p.nameBattleScore || 0,
        nameBattlePrefix: getNameBattlePrefix(p),
        nameBattleCode: p.nameBattleCode || ''
      };
    })
    .sort((a, b) => (b.wins - a.wins) || (b.played - a.played) || (b.winProb - a.winProb))
    .slice(0, 18);

  // 名字争夺战排行榜（按用户要求拆分为两榜）：
  // 高分：>=5 分前10名（支配者排行榜）
  // 低分：<= -1 分前10名（贱畜排行榜，最低分排最前）
  const allBattlePlayers = Array.from(playerStats.values())
    .filter(p => p.nameBattleEnabled)
    .map(p => ({
      guestId: p.guestId,
      nickname: p.nickname,
      gender: p.gender || 'male',
      genderLabel: p.genderLabel || null,
      nameBattleScore: p.nameBattleScore || 0,
      nameBattlePrefix: getNameBattlePrefix(p),
      nameBattleCode: p.nameBattleCode || ''
    }));

  const nameBattleHigh = allBattlePlayers
    .filter(p => (p.nameBattleScore || 0) >= 5)
    .sort((a, b) => b.nameBattleScore - a.nameBattleScore)
    .slice(0, 10);

  const nameBattleLow = allBattlePlayers
    .filter(p => (p.nameBattleScore || 0) <= -1)
    .sort((a, b) => a.nameBattleScore - b.nameBattleScore) // 越负越靠前（贱畜榜）
    .slice(0, 10);

  return {
    tables: tableList,
    onlineCount,
    totalRounds: totalRoundsPlayed,
    recentMatches: matchHistory.slice(0, 5),
    recentPunishments: punishmentHistory.slice(0, 5),
    // 在线名单（前端只显示前5 + 滚动）
    onlinePlayers,
    // 名字争夺战排行榜拆分：高分支配者 + 低分贱畜
    nameBattleHigh,
    nameBattleLow,
    // 留言板数据
    recentFeedbacks: feedbacks.slice(0, 12)
  };
}

function broadcastLobby() {
  io.emit('lobby_update', getLobbyData());
}

function broadcastTableUpdate(tableId) {
  const t = tables.get(tableId);
  if (!t) return;

  // 健壮性保护：如果少于两个在座玩家，强制清除惩罚任务
  const seatedCount = (t.playerA ? 1 : 0) + (t.playerB ? 1 : 0);
  if (seatedCount < 2 && t.currentPunishment) {
    clearPunishmentTimer(tableId);
    t.currentPunishment = null;
  }

  const room = `table-${tableId}`;
  io.to(room).emit('table_update', {
    id: t.id,
    name: t.name,
    playerA: t.playerA ? enrichPlayerForClient(t.playerA) : null,
    playerB: t.playerB ? enrichPlayerForClient(t.playerB) : null,
    round: t.round,
    timeLimit: t.timeLimit || 0,
    remainingTime: t.remainingTime || 0,
    punishmentStyle: t.punishmentStyle || 'none',
    punishmentStyles: t.punishmentStyles || [t.punishmentStyle || 'none'],
    currentPunishment: t.currentPunishment || null,
    spectators: (t.spectators || []).map(s => ({ guestId: s.guestId, nickname: s.nickname })),
    hasPassword: !!t.password,
    gameSettings: t.gameSettings || { mode: 'unlimited' },
    isNameBattleRoom: !!t.isNameBattleRoom,
    nameBattleBet: t.nameBattleBet || 0,
    movesStatus: {
      A: t.playerA ? !!t.moves[t.playerA.guestId] : false,
      B: t.playerB ? !!t.moves[t.playerB.guestId] : false
    },
    chat: t.chat.slice(-60)
  });
}

// 判断某玩家当前是否正处于需要完成的惩罚中（同时支持传统单人惩罚和双人平局惩罚）
function isPlayerCurrentlyPunished(table, guestId) {
  if (!table || !table.currentPunishment) return false;
  const cp = table.currentPunishment;

  if (cp.isDrawPunish && Array.isArray(cp.punished)) {
    // 双人惩罚模式
    return cp.punished.some(p => p.guestId === guestId && !p.completed);
  }

  // 传统单人惩罚
  return cp.loserGuestId === guestId;
}

function addChat(tableId, guestId, nickname, message) {
  const t = tables.get(tableId);
  if (!t) return null;
  const msg = {
    id: genId('M'),
    guestId,
    nickname: nickname || '游客',
    message: String(message).slice(0, 180),
    ts: Date.now()
  };

  // 附带当前名字争夺战状态（让聊天里 -200 以下的人只显示代号，全局隐藏真名）
  const p = playerStats.get(guestId);
  if (p) {
    msg.gender = p.gender || 'male';
    msg.genderLabel = p.genderLabel || null;
    msg.nameBattlePrefix = p.nameBattlePrefix || '';
    msg.nameBattleScore = p.nameBattleScore || 0;
    msg.nameBattleCode = p.nameBattleCode || '';
  }

  t.chat.push(msg);
  if (t.chat.length > 120) t.chat.shift();
  t.lastActivity = Date.now();
  return msg;
}

function resolveRoundIfReady(tableId) {
  const t = tables.get(tableId);
  if (!t || !t.playerA || !t.playerB) return false;

  const aId = t.playerA.guestId;
  const bId = t.playerB.guestId;
  const moveA = t.moves[aId];
  const moveB = t.moves[bId];
  if (!moveA || !moveB) return false;

  // compute result
  const choiceName = { chui: '锤子', jian: '剪刀', bu: '布' };
  let result = 'draw';
  let winnerSeat = null;

  if (moveA === moveB) {
    result = 'draw';
    updatePlayerResult(aId, 'draw');
    updatePlayerResult(bId, 'draw');
  } else if (
    (moveA === 'chui' && moveB === 'jian') ||
    (moveA === 'jian' && moveB === 'bu') ||
    (moveA === 'bu' && moveB === 'chui')
  ) {
    result = 'A';
    winnerSeat = 'A';
    t.playerA.score = (t.playerA.score || 0) + 1;
    updatePlayerResult(aId, 'win');
    updatePlayerResult(bId, 'loss');
  } else {
    result = 'B';
    winnerSeat = 'B';
    t.playerB.score = (t.playerB.score || 0) + 1;
    updatePlayerResult(aId, 'loss');
    updatePlayerResult(bId, 'win');
  }

  // ===== 名字争夺战分数结算（仅在名字争夺战房间 + 双方都开启时生效） =====
  if (t.isNameBattleRoom && t.nameBattleBet > 0) {
    try {
      const pa = playerStats.get(aId);
      const pb = playerStats.get(bId);

      if (pa && pb && pa.nameBattleEnabled && pb.nameBattleEnabled) {
      const bet = t.nameBattleBet;

      // 保存变更前分数，用于检测掉出顶级（120分以下）时把称号并入真实名字（名字变更规则）
      const paScoreBefore = pa.nameBattleScore || 0;
      const pbScoreBefore = pb.nameBattleScore || 0;

      // 按阶段难度应用实际积分变动（获取减成 / 掉分保护）
      let paActualDelta = 0;
      let pbActualDelta = 0;

      if (result === 'A') {
        // A 赢 → A 获取（受自己 gainMult 影响），B 扣分（受 B lossMult 影响）
        const gainMult = getNameBattleGainMultiplier(pa.nameBattleScore || 0);
        const lossMult = getNameBattleLossMultiplier(pb.nameBattleScore || 0);
        paActualDelta = Math.round(bet * gainMult);
        pbActualDelta = -Math.round(bet * lossMult);
      } else if (result === 'B') {
        const gainMult = getNameBattleGainMultiplier(pb.nameBattleScore || 0);
        const lossMult = getNameBattleLossMultiplier(pa.nameBattleScore || 0);
        pbActualDelta = Math.round(bet * gainMult);
        paActualDelta = -Math.round(bet * lossMult);
      } else if (result === 'draw' && t.gameSettings && t.gameSettings.punishOnDraw) {
        // 平局双罚：双方都按各自的 lossMult 扣分（女王保护生效，底层扣分不变）
        const lossMultA = getNameBattleLossMultiplier(pa.nameBattleScore || 0);
        const lossMultB = getNameBattleLossMultiplier(pb.nameBattleScore || 0);
        paActualDelta = -Math.round(bet * lossMultA);
        pbActualDelta = -Math.round(bet * lossMultB);
      }

      pa.nameBattleScore = clampNameBattleScore( (pa.nameBattleScore || 0) + paActualDelta );
      pb.nameBattleScore = clampNameBattleScore( (pb.nameBattleScore || 0) + pbActualDelta );

      // 触发前缀重新评估（会自动sticky）
      getNameBattlePrefix(pa);
      getNameBattlePrefix(pb);

      // 用户要求：积分掉到300以下，直接把当前称号并入真实名字（名字变成称号），不再单独显示称号
      const bakeTitleIfDroppedBelow300 = (player, scoreBefore) => {
        if (scoreBefore >= 300 && (player.nameBattleScore || 0) < 300 && player.nameBattlePrefix) {
          const title = player.nameBattlePrefix;
          const cleanNick = (player.nickname || '').replace(/^逃跑的/, '').trim();
          if (!cleanNick.startsWith(title)) {
            player.nickname = `${title} ${cleanNick}`;
          }
          // 清空动态前缀字段，这样显示时不再重复出现称号（已并入名字）
          player.nameBattlePrefix = '';
          player.nameBattlePrefixTier = getNameBattleTier(player.nameBattleScore || 0);

          // 同步在线玩家信息和所有座位
          for (const [sockId, oinfo] of onlineSockets.entries()) {
            if (oinfo.guestId === player.guestId) {
              oinfo.nickname = player.nickname;
            }
          }
          for (const t2 of tables.values()) {
            if (t2.playerA && t2.playerA.guestId === player.guestId) t2.playerA.nickname = player.nickname;
            if (t2.playerB && t2.playerB.guestId === player.guestId) t2.playerB.nickname = player.nickname;
          }
        }
      };
      bakeTitleIfDroppedBelow300(pa, paScoreBefore);
      bakeTitleIfDroppedBelow300(pb, pbScoreBefore);

      // 当积分掉到代号模式（<= -200），把代号直接并入真实名字（名字变成代号，但不额外显示称号）
      // 这样之后逃跑时就会自然变成 “逃跑的SLAVE-XXXX”
      const bakeCodeIfEnteredSlave = (player, scoreBefore) => {
        if (scoreBefore > -200 && (player.nameBattleScore || 0) <= -200 && player.nameBattleCode) {
          const code = player.nameBattleCode;
          // 直接把真实名字改成代号（这是“300分被更改名字但不显示”的低分版本）
          player.nickname = code;
          // 清空动态前缀/称号字段，以后显示时不再重复
          player.nameBattlePrefix = '';
          player.nameBattlePrefixTier = getNameBattleTier(player.nameBattleScore || 0);

          // 同步在线信息和座位
          for (const [sockId, oinfo] of onlineSockets.entries()) {
            if (oinfo.guestId === player.guestId) {
              oinfo.nickname = player.nickname;
            }
          }
          for (const t2 of tables.values()) {
            if (t2.playerA && t2.playerA.guestId === player.guestId) t2.playerA.nickname = player.nickname;
            if (t2.playerB && t2.playerB.guestId === player.guestId) t2.playerB.nickname = player.nickname;
          }
        }
      };
      bakeCodeIfEnteredSlave(pa, paScoreBefore);
      bakeCodeIfEnteredSlave(pb, pbScoreBefore);

      // 如果实际积分变动受阶段难度影响，提示玩家（让大家理解低阶爬分难 / 高阶掉分难）
      if (Math.abs(paActualDelta) !== bet || Math.abs(pbActualDelta) !== bet) {
        const sys = addChat(tableId, 'system', '系统',
          `名字争夺战受阶段难度影响 → 实际变动：A ${paActualDelta >= 0 ? '+' : ''}${paActualDelta}，B ${pbActualDelta >= 0 ? '+' : ''}${pbActualDelta}`);
        if (sys) io.to(`table-${tableId}`).emit('chat_message', sys);
      }

      // 平局双输时的额外提示（显示实际扣除，女王等高阶可能少扣）
      if (result === 'draw' && t.gameSettings && t.gameSettings.punishOnDraw) {
        const actualA = Math.abs(paActualDelta);
        const actualB = Math.abs(pbActualDelta);
        let drawMsg = `平局双输！`;
        if (actualA === actualB) {
          drawMsg += `双方名字争夺战各扣 ${actualA} 分`;
        } else {
          drawMsg += `A方扣 ${actualA} 分，B方扣 ${actualB} 分（按各自阶段难度）`;
        }
        const sys = addChat(tableId, 'system', '系统', drawMsg);
        if (sys) io.to(`table-${tableId}`).emit('chat_message', sys);
      }

      // 趣味里程碑广播
      const checkMilestone = (player, oldScore) => {
        const newScore = player.nameBattleScore || 0;
        if (oldScore < 120 && newScore >= 120) {
          const display = getDisplayNameForPlayer(player.guestId);
          const sys = addChat(tableId, 'system', '系统', `🎉 ${display} 达到了120分！已登顶名字争夺战顶级支配！`);
          if (sys) io.to(`table-${tableId}`).emit('chat_message', sys);
        }
        if (oldScore > -200 && newScore <= -200) {
          const display = getDisplayNameForPlayer(player.guestId);
          const sys = addChat(tableId, 'system', '系统', `💀 ${display} 跌破-200分，彻底失去了名字，成为了 ${player.nameBattleCode}！`);
          if (sys) io.to(`table-${tableId}`).emit('chat_message', sys);
        }
      };

      // 计算旧分数用于里程碑判断（必须用实际变动后的 delta，否则女王保护/低阶减成会算错里程碑）
      const paDelta = paActualDelta;
      const pbDelta = pbActualDelta;

      const paOld = (pa.nameBattleScore || 0) - paDelta;
      const pbOld = (pb.nameBattleScore || 0) - pbDelta;

      // 只要有分数变动就检查里程碑（包括平局双输）
      if (paDelta !== 0 || pbDelta !== 0) {
        checkMilestone(pa, paOld);
        checkMilestone(pb, pbOld);
      }

      // 分数变动后立即刷新全服名字争夺战排行榜
      broadcastLobby();

      // 推送名字争夺战个人状态更新（让前端本地my*和座位名字栏实时同步自己的称号/积分）
      for (const [sockId, info] of onlineSockets.entries()) {
        if (info.guestId === aId || info.guestId === bId) {
          const pp = playerStats.get(info.guestId);
          if (pp && pp.nameBattleEnabled) {
            try {
              io.to(sockId).emit('name_battle_updated', {
                enabled: true,
                score: pp.nameBattleScore || 0,
                prefix: pp.nameBattlePrefix || '',
                code: pp.nameBattleCode || '',
                quitLockUntil: pp.nameBattleQuitLockUntil || 0
              });
            } catch (_) {}
          }
        }
      }
    }
    } catch (e) {
      console.error('【名字争夺战结算错误】', e);
    }
  }

  totalRoundsPlayed++;

  // record history（带性别信息 + 名字争夺战状态，用于大厅最近对局显示彩色全称框 + -200 隐藏真名）
  const paStats = playerStats.get(aId);
  const pbStats = playerStats.get(bId);
  const record = {
    ts: Date.now(),
    table: t.name,
    a: t.playerA.nickname,
    b: t.playerB.nickname,
    aGender: t.playerA.gender || 'male',
    aGenderLabel: t.playerA.genderLabel || null,
    bGender: t.playerB.gender || 'male',
    bGenderLabel: t.playerB.genderLabel || null,
    aNameBattlePrefix: paStats ? (paStats.nameBattlePrefix || '') : '',
    aNameBattleScore: paStats ? (paStats.nameBattleScore || 0) : 0,
    aNameBattleCode: paStats ? (paStats.nameBattleCode || '') : '',
    bNameBattlePrefix: pbStats ? (pbStats.nameBattlePrefix || '') : '',
    bNameBattleScore: pbStats ? (pbStats.nameBattleScore || 0) : 0,
    bNameBattleCode: pbStats ? (pbStats.nameBattleCode || '') : '',
    aChoice: choiceName[moveA],
    bChoice: choiceName[moveB],
    result: result === 'draw' ? '平局' : (result === 'A' ? `${t.playerA.nickname}胜` : `${t.playerB.nickname}胜`)
  };
  matchHistory.unshift(record);
  if (matchHistory.length > 80) matchHistory.pop();

  // notify players in room with full reveal（带性别信息 + 名字争夺战实时称号积分）
  io.to(`table-${tableId}`).emit('round_result', {
    round: t.round,
    moveA,
    moveB,
    result,                // 'A' | 'B' | 'draw'
    winnerName: result === 'draw' ? null : (result === 'A' ? t.playerA.nickname : t.playerB.nickname),
    scores: {
      A: t.playerA.score || 0,
      B: t.playerB.score || 0
    },
    aNickname: t.playerA.nickname,
    bNickname: t.playerB.nickname,
    aGender: t.playerA.gender || 'male',
    aGenderLabel: t.playerA.genderLabel || null,
    bGender: t.playerB.gender || 'male',
    bGenderLabel: t.playerB.genderLabel || null,
    // 名字争夺战实时数据（用于结果横幅和后续渲染）
    aNameBattlePrefix: paStats ? (paStats.nameBattlePrefix || '') : '',
    aNameBattleScore: paStats ? (paStats.nameBattleScore || 0) : 0,
    aNameBattleCode: paStats ? (paStats.nameBattleCode || '') : '',
    bNameBattlePrefix: pbStats ? (pbStats.nameBattlePrefix || '') : '',
    bNameBattleScore: pbStats ? (pbStats.nameBattleScore || 0) : 0,
    bNameBattleCode: pbStats ? (pbStats.nameBattleCode || '') : ''
  });

  // reset for next round
  t.moves = {};
  t.round += 1;
  t.lastActivity = Date.now();

  // push a system message
  let resultText = '平局';
  try {
    if (result !== 'draw' && winnerSeat) {
      const winnerId = winnerSeat === 'A' ? aId : bId;
      const winnerDisplay = getDisplayNameForPlayer(winnerId);
      resultText = `${winnerDisplay}胜`;
    }
  } catch (e) {
    console.error('Error building resultText in round end:', e);
    resultText = result === 'draw' ? '平局' : '有人胜';
  }
  const sysMsg = addChat(tableId, 'system', '系统', `第 ${t.round - 1} 局结束，${resultText}`);
  if (sysMsg) {
    io.to(`table-${tableId}`).emit('chat_message', sysMsg);
  }

  broadcastTableUpdate(tableId);
  broadcastLobby();

  // 惩罚模式分支：
  const shouldPunishOnDraw = t.gameSettings && t.gameSettings.punishOnDraw;

  // 只有在「平局 + 房间开启了平局惩罚双方」时，才触发双方惩罚
  // 正常有输家的情况下，永远只惩罚输家（与是否开启平局双罚无关）
  const isDrawPunishThisRound = (result === 'draw' && shouldPunishOnDraw);

  if (t.punishmentStyle !== 'none' && (result !== 'draw' || isDrawPunishThisRound)) {
    punishment.triggerPunishmentPhase(tableId, result, aId, bId, isDrawPunishThisRound);
  } else {
    // 普通平局（未开启平局双罚）→ 直接进入下一局
    if (t.punishmentStyle !== 'none' && result === 'draw' && !shouldPunishOnDraw) {
      const drawSys = addChat(tableId, 'system', '系统', '平局！本局无惩罚，直接进入下一局');
      if (drawSys) {
        io.to(`table-${tableId}`).emit('chat_message', drawSys);
      }
    }
  }

  return true;
}

// 移动计时器系统已完全移除（出拳永远无限制）
// 以下函数已删除以避免崩溃
// function clearMoveTimer... (已移除)

function clearPunishmentTimer(tableId) {
  if (punishmentTicks.has(tableId)) {
    clearInterval(punishmentTicks.get(tableId));
    punishmentTicks.delete(tableId);
  }
}

// 断线保护系统已完全移除（断线即直接踢出，不再有45秒重连保护）

// startMoveTimer / forceResolveByTimeout / clearMoveTimer 已完全移除
// （用户要求无时限，出拳永远无限制，防止闪退）

// 惩罚核心已完全移到 punishment.js 模块（支持 tattoo 随机 + 50条轻度更涩版）
// 所有调用走 punishment.triggerPunishmentPhase / punishment.completePunishment
// ============ Socket.IO ============
io.on('connection', (socket) => {
  console.log('[connect]', socket.id);

  socket.on('join_lobby', (payload) => {
    const { guestId, nickname, gender, genderLabel } = payload || {};
    const player = getOrCreatePlayer(guestId, nickname, gender, genderLabel);
    applyNameBattleDecay(player);

    onlineSockets.set(socket.id, {
      guestId: player.guestId,
      nickname: player.nickname,
      gender: player.gender,
      genderLabel: player.genderLabel || null,
      tableId: null
    });

    socket.emit('welcome', {
      guestId: player.guestId,
      nickname: player.nickname,
      gender: player.gender,
      genderLabel: player.genderLabel || null,
      nameBattleEnabled: !!player.nameBattleEnabled,
      nameBattleScore: player.nameBattleScore || 0,
      nameBattlePrefix: getNameBattlePrefix(player),
      nameBattleCode: player.nameBattleCode || '',
      stats: { ...player }
    });

    // 推送好友列表
    socket.emit('friend_update', { friends: getFriendList(player.guestId), requests: getPendingRequests(player.guestId), unread: getUnreadCounts(player.guestId) });

    socket.emit('lobby_update', getLobbyData());
  });

  socket.on('set_profile', (data = {}) => {
    const info = onlineSockets.get(socket.id);
    if (!info) return;

    const p = playerStats.get(info.guestId);
    // 名字争夺战或退出锁定期间禁止改名
    if (p && (p.nameBattleEnabled || (p.nameBattleQuitLockUntil && Date.now() < p.nameBattleQuitLockUntil))) {
      // 只允许改性别，不允许改昵称
      if (data.nickname && data.nickname !== info.nickname) {
        socket.emit('error_msg', '名字争夺战期间或退出惩罚期间无法修改昵称');
        return;
      }
    }

    const cleanNick = String(data.nickname || '').trim().slice(0, 16) || info.nickname;
    const newGender = data.gender;
    const newGenderLabel = data.genderLabel;

    // Reuse the p we already fetched earlier for name battle check
    if (p) {
      p.nickname = cleanNick;
      if (newGender && (newGender === 'male' || newGender === 'female' || newGender === 'femboy')) {
        p.gender = newGender;
      }
      if (newGenderLabel) {
        p.genderLabel = newGenderLabel;
      }
    }
    info.nickname = cleanNick;
    if (newGender && (newGender === 'male' || newGender === 'female' || newGender === 'femboy')) {
      info.gender = newGender;
    }
    if (newGenderLabel) {
      info.genderLabel = newGenderLabel;
    }

    // update any seated tables
    for (const t of tables.values()) {
      if (t.playerA && t.playerA.guestId === info.guestId) {
        t.playerA.nickname = cleanNick;
        if (newGender) t.playerA.gender = newGender;
        if (newGenderLabel) t.playerA.genderLabel = newGenderLabel;
      }
      if (t.playerB && t.playerB.guestId === info.guestId) {
        t.playerB.nickname = cleanNick;
        if (newGender) t.playerB.gender = newGender;
        if (newGenderLabel) t.playerB.genderLabel = newGenderLabel;
      }
    }
    socket.emit('nickname_updated', { nickname: cleanNick, gender: info.gender || p?.gender || 'male', genderLabel: info.genderLabel || p?.genderLabel || null });
    broadcastLobby();
    if (info.tableId) broadcastTableUpdate(info.tableId);
  });

  // ===== 名字争夺战开关 =====
  socket.on('set_name_battle', (enabled) => {
    const info = onlineSockets.get(socket.id);
    if (!info) return;
    const p = playerStats.get(info.guestId);
    if (!p) return;

    const wasEnabled = !!p.nameBattleEnabled;
    const nowEnabled = !!enabled;

    if (wasEnabled === nowEnabled) return;

    p.nameBattleEnabled = nowEnabled;
    info.nameBattleEnabled = nowEnabled;

    if (nowEnabled) {
      // 开启：清空退出锁定
      p.nameBattleQuitLockUntil = 0;
    } else {
      // 关闭名字争夺战：直接在真实名字前面加“逃跑的”
      // 注意：这里改的是真实昵称（不是当前显示的代号）。
      // 例如你叫“林心悦”，无论你当前因为低分显示成 SLAVE-XXXX，离开时都会变成 “逃跑的林心悦”。
      // 想去掉“逃跑的”前缀，必须自己去个人设定里手动修改（90分钟锁定期间无法改）。
      p.nameBattleScore = 0; // 逃跑重置为0（已在上下限内）
      p.nameBattlePrefix = '';
      p.nameBattlePrefixTier = 0;
      p.nameBattleCode = ''; // 清年代号
      p.nameBattleQuitLockUntil = Date.now() + 90 * 60 * 1000; // 90分钟

      // 强制改当前真实昵称为“逃跑的xxx”（基于真实昵称，不是显示的代号）
      const escapedName = `逃跑的${p.nickname.replace(/^逃跑的/, '')}`;
      p.nickname = escapedName;
      info.nickname = escapedName;

      // 更新当前所在桌的座位昵称
      for (const t of tables.values()) {
        if (t.playerA && t.playerA.guestId === info.guestId) t.playerA.nickname = escapedName;
        if (t.playerB && t.playerB.guestId === info.guestId) t.playerB.nickname = escapedName;
      }
    }

    // 通知前端
    socket.emit('name_battle_updated', {
      enabled: nowEnabled,
      score: p.nameBattleScore,
      prefix: p.nameBattlePrefix,
      code: p.nameBattleCode || '',
      quitLockUntil: p.nameBattleQuitLockUntil
    });

    // 广播更新
    broadcastLobby();
    if (info.tableId) broadcastTableUpdate(info.tableId);
  });

  // 兼容旧的 set_nickname（只改名字）
  socket.on('set_nickname', (newNick) => {
    const info = onlineSockets.get(socket.id);
    if (!info) return;

    const p = playerStats.get(info.guestId);
    // 名字争夺战开启或退出锁定期间禁止改名
    if (p && (p.nameBattleEnabled || (p.nameBattleQuitLockUntil && Date.now() < p.nameBattleQuitLockUntil))) {
      socket.emit('error_msg', '名字争夺战期间或退出惩罚期间无法修改昵称');
      return;
    }

    const clean = String(newNick || '').trim().slice(0, 16) || '游客';
    if (p) p.nickname = clean;
    info.nickname = clean;

    for (const t of tables.values()) {
      if (t.playerA && t.playerA.guestId === info.guestId) t.playerA.nickname = clean;
      if (t.playerB && t.playerB.guestId === info.guestId) t.playerB.nickname = clean;
    }
    socket.emit('nickname_updated', { nickname: clean, gender: info.gender || p?.gender || 'male', genderLabel: info.genderLabel || p?.genderLabel || null });
    broadcastLobby();
    if (info.tableId) broadcastTableUpdate(info.tableId);
  });

  socket.on('create_table', (data = {}) => {
    const info = onlineSockets.get(socket.id);
    if (!info) return;

    if (info.tableId) leaveTable(socket, info.tableId);

    const timeLimit = Number(data.timeLimit) || 0;
    const punishmentStyles = data.punishmentStyles || (data.punishmentStyle ? [data.punishmentStyle] : ['none']);
    const password = data.password || null;
    const gameSettings = data.gameSettings || {};
    const isNameBattleRoom = !!data.isNameBattleRoom;
    const nameBattleBet = Number(data.nameBattleBet) || 0;

    // 强制要求：创建名字争夺战房间前必须自己开启名字争夺战
    if (isNameBattleRoom) {
      const creatorStats = playerStats.get(info.guestId);
      if (!creatorStats || !creatorStats.nameBattleEnabled) {
        socket.emit('error_msg', '必须先在「个人设定」中开启名字争夺战，才能创建名字争夺战房间');
        return;
      }
    }

    const table = createTable(info, data.name, timeLimit, punishmentStyles, password, gameSettings, isNameBattleRoom, nameBattleBet);
    info.tableId = table.id;

    socket.join(`table-${table.id}`);

    const full = serializeTable(table, info.guestId);
    socket.emit('table_joined', full);
    broadcastLobby();
  });

  socket.on('join_table', ({ tableId, password }) => {
    const info = onlineSockets.get(socket.id);
    if (!info || !tables.has(tableId)) {
      socket.emit('error_msg', '桌子不存在');
      return;
    }

    const t = tables.get(tableId);

    // 严格限制：未开启名字争夺战的玩家完全不能进入名字争夺战房间
    if (t.isNameBattleRoom) {
      const p = playerStats.get(info.guestId);
      if (!p || !p.nameBattleEnabled) {
        socket.emit('error_msg', '该房间为名字争夺战专属，你未开启名字争夺战，无法进入');
        return;
      }
    }

    // 密码房校验
    if (t.password && t.password !== password) {
      socket.emit('error_msg', '密码错误，无法加入');
      return;
    }

    // already in this table?
    if (info.tableId === tableId) {
      socket.emit('table_joined', serializeTable(t, info.guestId));
      return;
    }

    // 断线保护已完全移除，不支持重连
    // leave old first
    if (info.tableId) leaveTable(socket, info.tableId);

    // seat logic
    if (!t.playerA) {
      t.playerA = { guestId: info.guestId, nickname: info.nickname, gender: info.gender || 'male', genderLabel: info.genderLabel || null, score: 0 };
    } else if (!t.playerB) {
      t.playerB = { guestId: info.guestId, nickname: info.nickname, gender: info.gender || 'male', genderLabel: info.genderLabel || null, score: 0 };
    } else {
      // Table full → join as spectator
      const alreadySpectating = (t.spectators || []).some(s => s.guestId === info.guestId);
      if (!alreadySpectating) {
        (t.spectators = t.spectators || []).push({
          guestId: info.guestId,
          nickname: info.nickname,
          gender: info.gender || 'male',
          socketId: socket.id
        });
      }
    }

    info.tableId = tableId;
    socket.join(`table-${tableId}`);

    // system message
    const displayName = getDisplayNameForPlayer(info.guestId);
    const sys = addChat(tableId, 'system', '系统', `${displayName} 加入了桌子`);
    io.to(`table-${tableId}`).emit('chat_message', sys);

    socket.emit('table_joined', serializeTable(t, info.guestId));
    broadcastTableUpdate(tableId);
    broadcastLobby();

    // 时限已移除，无需启动计时器
  });

  socket.on('leave_table', () => {
    const info = onlineSockets.get(socket.id);
    if (!info || !info.tableId) return;
    leaveTable(socket, info.tableId);
  });

  function leaveTable(socket, tableId) {
    const info = onlineSockets.get(socket.id);
    if (!info) return;

    const t = tables.get(tableId);
    if (!t) {
      info.tableId = null;
      return;
    }

    const wasSeatedPlayer = (t.playerA && t.playerA.guestId === info.guestId) ||
                             (t.playerB && t.playerB.guestId === info.guestId);

    // remove from seat if seated
    if (t.playerA && t.playerA.guestId === info.guestId) t.playerA = null;
    if (t.playerB && t.playerB.guestId === info.guestId) t.playerB = null;

    // remove from spectators if present
    if (t.spectators) {
      t.spectators = t.spectators.filter(s => s.guestId !== info.guestId);
    }

    // clear their pending move
    delete t.moves[info.guestId];

    info.tableId = null;
    socket.leave(`table-${tableId}`);

    // announce
    const displayName = getDisplayNameForPlayer(info.guestId);
    const sys = addChat(tableId, 'system', '系统', `${displayName} 离开了桌子`);
    io.to(`table-${tableId}`).emit('chat_message', sys);

    // 只要是坐着的玩家离开，就立即清除惩罚任务（防止另一人被卡住）
    if (wasSeatedPlayer && t.currentPunishment) {
      clearPunishmentTimer(tableId);
      t.currentPunishment = null;
      const cancelSys = addChat(tableId, 'system', '系统', '有玩家离开，惩罚任务已自动清除');
      if (cancelSys) io.to(`table-${tableId}`).emit('chat_message', cancelSys);
    }

    if (!t.playerA && !t.playerB) {
      tables.delete(tableId);
      io.to(`table-${tableId}`).emit('table_closed');
    } else {
      broadcastTableUpdate(tableId);
    }

    socket.emit('left_table');
    broadcastLobby();
  }

  socket.on('send_chat', ({ tableId, message }) => {
    const info = onlineSockets.get(socket.id);
    if (!info || !tableId || !message) return;

    const t = tables.get(tableId);
    if (!t) return;

    // 快速消息防刷屏（客户端已有6秒限制，服务端再加一层保护）
    const now = Date.now();
    const last = lastQuickMsg.get(socket.id) || 0;
    if (now - last < 1500) { // 服务端最少1.5秒
      return;
    }
    lastQuickMsg.set(socket.id, now);

    const msg = addChat(tableId, info.guestId, info.nickname, message);
    if (msg) {
      io.to(`table-${tableId}`).emit('chat_message', msg);
    }
  });

  socket.on('make_move', ({ tableId, choice }) => {
    const info = onlineSockets.get(socket.id);
    if (!info || !tableId) return;
    if (!['chui', 'jian', 'bu'].includes(choice)) return;

    const t = tables.get(tableId);
    if (!t) return;

    // 惩罚模式下，正在受惩罚的玩家（单人或双人模式下未完成者）被禁止出拳
    if (t.punishmentStyle !== 'none' && t.currentPunishment) {
      if (isPlayerCurrentlyPunished(t, info.guestId)) {
        socket.emit('error_msg', '请先完成惩罚才能出拳');
        return;
      }
      // 未受惩罚的玩家可以正常出拳
    }

    const isA = t.playerA && t.playerA.guestId === info.guestId;
    const isB = t.playerB && t.playerB.guestId === info.guestId;
    if (!isA && !isB) {
      socket.emit('error_msg', '只有在座玩家才能出拳');
      return;
    }

    // record move (idempotent)
    t.moves[info.guestId] = choice;
    t.lastActivity = Date.now();

    // tell everyone (without revealing what)
    broadcastTableUpdate(tableId);

    // try resolve
    const resolved = resolveRoundIfReady(tableId);
    if (!resolved) {
      // notify "waiting for opponent"
      io.to(`table-${tableId}`).emit('move_status', {
        by: isA ? 'A' : 'B',
        guestId: info.guestId
      });
    }
  });

  socket.on('reset_scores', (tableId) => {
    const info = onlineSockets.get(socket.id);
    const t = tables.get(tableId);
    if (!t || !info) return;
    const isPlayer = (t.playerA && t.playerA.guestId === info.guestId) || (t.playerB && t.playerB.guestId === info.guestId);
    if (!isPlayer) return;

    if (t.playerA) t.playerA.score = 0;
    if (t.playerB) t.playerB.score = 0;
    t.round = 1;
    t.moves = {};
    clearPunishmentTimer(tableId);
    t.currentPunishment = null;
    broadcastTableUpdate(tableId);
    const sys = addChat(tableId, 'system', '系统', '比分已重置，惩罚任务已清除');
    io.to(`table-${tableId}`).emit('chat_message', sys);
  });

  // 玩家确认完成轮盘惩罚（可带心情emoji）
  socket.on('punishment_completed', ({ tableId, emoji }) => {
    const info = onlineSockets.get(socket.id);
    if (!info || !tableId) return;

    const success = punishment.completePunishment(tableId, info.guestId, emoji || null);
    if (!success) {
      socket.emit('error_msg', '只有本局输家才能确认完成惩罚');
    }
  });

  // 观众点击空座位快速上桌
  socket.on('take_seat', ({ tableId, seat }) => {
    const info = onlineSockets.get(socket.id);
    if (!info || !tableId || !['A', 'B'].includes(seat)) return;

    const t = tables.get(tableId);
    if (!t) return;

    // 名字争夺战房间限制：未开启者不能上桌
    if (t.isNameBattleRoom) {
      const p = playerStats.get(info.guestId);
      if (!p || !p.nameBattleEnabled) {
        socket.emit('error_msg', '该房间为名字争夺战专属，你未开启名字争夺战，无法上桌（可观战）');
        return;
      }
    }

    // 必须已经在桌子内（玩家或观众）
    const isInTable = (t.playerA && t.playerA.guestId === info.guestId) ||
                      (t.playerB && t.playerB.guestId === info.guestId) ||
                      (t.spectators || []).some(s => s.guestId === info.guestId);

    if (!isInTable) {
      socket.emit('error_msg', '请先加入桌子');
      return;
    }

    const targetSeat = seat === 'A' ? 'playerA' : 'playerB';
    if (t[targetSeat]) {
      socket.emit('error_msg', '该位置已有人');
      return;
    }

    // 上桌（断线保护已移除）
    t[targetSeat] = {
      guestId: info.guestId,
      nickname: info.nickname,
      gender: info.gender || 'male',
      genderLabel: info.genderLabel || null,
      score: 0
    };

    // 如果之前是观众，从观众列表移除
    if (t.spectators) {
      t.spectators = t.spectators.filter(s => s.guestId !== info.guestId);
    }

    // 清除可能的移动
    delete t.moves[info.guestId];

    const displayName = getDisplayNameForPlayer(info.guestId);
    const sys = addChat(tableId, 'system', '系统', `${displayName} 坐到了位置 ${seat}`);
    io.to(`table-${tableId}`).emit('chat_message', sys);

    broadcastTableUpdate(tableId);
    broadcastLobby();
  });

  // 留言板反馈（bug报告 + 更新建议）
  socket.on('send_feedback', (payload = {}) => {
    const info = onlineSockets.get(socket.id);
    if (!info) return;

    const guestId = info.guestId;
    const now = Date.now();
    const last = feedbackCooldown.get(guestId) || 0;

    // 1分钟冷却 + 30字限制
    if (now - last < 60 * 1000) {
      socket.emit('error_msg', '反馈太频繁，请1分钟后再试');
      return;
    }

    let text = String(payload.message || '').trim().slice(0, 30);
    if (!text) return;

    // 附带名字争夺战状态，让留言板里 -200 以下的人只显示代号
    const p = playerStats.get(guestId);
    const record = {
      ts: now,
      guestId,
      nickname: info.nickname || '游客',
      gender: info.gender || 'male',
      genderLabel: info.genderLabel || null,
      nameBattlePrefix: p ? (p.nameBattlePrefix || '') : '',
      nameBattleScore: p ? (p.nameBattleScore || 0) : 0,
      nameBattleCode: p ? (p.nameBattleCode || '') : '',
      text
    };

    feedbacks.unshift(record);
    if (feedbacks.length > 20) feedbacks.pop();

    feedbackCooldown.set(guestId, now);

    // 实时推送给所有人 + 全量大厅更新
    io.emit('feedback_added', record);
    broadcastLobby();
  });

  // ===== 好友系统 =====
  socket.on('friend_search', (targetId) => {
    const info = onlineSockets.get(socket.id);
    if (!info) return;
    const p = playerStats.get(targetId);
    if (!p) {
      socket.emit('friend_search_result', { found: false, targetId });
      return;
    }
    socket.emit('friend_search_result', {
      found: true,
      targetId: p.guestId,
      nickname: p.nickname,
      gender: p.gender,
      genderLabel: p.genderLabel,
      nameBattlePrefix: p.nameBattlePrefix || '',
      nameBattleScore: p.nameBattleScore || 0,
      nameBattleCode: p.nameBattleCode || ''
    });
  });

  socket.on('friend_request_send', (targetId) => {
    const info = onlineSockets.get(socket.id);
    if (!info || !targetId || targetId === info.guestId) return;

    // 检查是否已经是好友
    const key = getFriendshipKey(info.guestId, targetId);
    if (friendships.has(key)) {
      socket.emit('error_msg', '对方已经是你的好友');
      return;
    }

    // 检查目标是否存在
    const target = playerStats.get(targetId);
    if (!target) {
      socket.emit('error_msg', '用户不存在');
      return;
    }

    // 检查是否已经发送过请求
    const targetReqs = friendRequests.get(targetId) || [];
    if (targetReqs.some(r => r.from === info.guestId)) {
      socket.emit('error_msg', '好友请求已发送，等待对方处理');
      return;
    }

    // 检查对方是否已向我发送请求（如果是，自动双向通过）
    const myReqs = friendRequests.get(info.guestId) || [];
    const mutual = myReqs.find(r => r.from === targetId);
    if (mutual) {
      // 自动双向接受
      friendships.add(key);
      friendRequests.set(info.guestId, myReqs.filter(r => r.from !== targetId));
      socket.emit('friend_update', { friends: getFriendList(info.guestId), requests: getPendingRequests(info.guestId), unread: getUnreadCounts(info.guestId) });
      // 通知对方
      for (const [sid, oinfo] of onlineSockets.entries()) {
        if (oinfo.guestId === targetId) {
          io.to(sid).emit('friend_update', { friends: getFriendList(targetId), requests: getPendingRequests(targetId), unread: getUnreadCounts(targetId) });
          io.to(sid).emit('friend_request_auto_accepted', { from: info.guestId, nickname: info.nickname });
          break;
        }
      }
      socket.emit('friend_request_auto_accepted', { from: targetId, nickname: target.nickname });
      return;
    }

    // 添加请求
    if (!friendRequests.has(targetId)) friendRequests.set(targetId, []);
    friendRequests.get(targetId).push({ from: info.guestId, ts: Date.now() });

    socket.emit('friend_request_sent', { targetId, nickname: target.nickname });

    // 实时通知对方
    for (const [sid, oinfo] of onlineSockets.entries()) {
      if (oinfo.guestId === targetId) {
        io.to(sid).emit('friend_request_received', {
          from: info.guestId,
          nickname: info.nickname,
          gender: info.gender,
          genderLabel: info.genderLabel,
          ts: Date.now()
        });
        io.to(sid).emit('friend_update', { friends: getFriendList(targetId), requests: getPendingRequests(targetId), unread: getUnreadCounts(targetId) });
        break;
      }
    }
  });

  socket.on('friend_request_accept', (fromId) => {
    const info = onlineSockets.get(socket.id);
    if (!info || !fromId) return;

    const myReqs = friendRequests.get(info.guestId) || [];
    if (!myReqs.some(r => r.from === fromId)) {
      socket.emit('error_msg', '该好友请求不存在');
      return;
    }

    const key = getFriendshipKey(info.guestId, fromId);
    friendships.add(key);
    friendRequests.set(info.guestId, myReqs.filter(r => r.from !== fromId));

    socket.emit('friend_update', { friends: getFriendList(info.guestId), requests: getPendingRequests(info.guestId), unread: getUnreadCounts(info.guestId) });

    // 通知对方
    for (const [sid, oinfo] of onlineSockets.entries()) {
      if (oinfo.guestId === fromId) {
        io.to(sid).emit('friend_update', { friends: getFriendList(fromId), requests: getPendingRequests(fromId), unread: getUnreadCounts(fromId) });
        break;
      }
    }
  });

  socket.on('friend_request_reject', (fromId) => {
    const info = onlineSockets.get(socket.id);
    if (!info || !fromId) return;

    const myReqs = friendRequests.get(info.guestId) || [];
    friendRequests.set(info.guestId, myReqs.filter(r => r.from !== fromId));

    socket.emit('friend_update', { friends: getFriendList(info.guestId), requests: getPendingRequests(info.guestId), unread: getUnreadCounts(info.guestId) });
  });

  socket.on('friend_remove', (targetId) => {
    const info = onlineSockets.get(socket.id);
    if (!info || !targetId) return;

    const key = getFriendshipKey(info.guestId, targetId);
    friendships.delete(key);

    socket.emit('friend_update', { friends: getFriendList(info.guestId), requests: getPendingRequests(info.guestId), unread: getUnreadCounts(info.guestId) });

    // 通知对方
    for (const [sid, oinfo] of onlineSockets.entries()) {
      if (oinfo.guestId === targetId) {
        io.to(sid).emit('friend_update', { friends: getFriendList(targetId), requests: getPendingRequests(targetId), unread: getUnreadCounts(targetId) });
        break;
      }
    }
  });

  socket.on('friend_list', () => {
    const info = onlineSockets.get(socket.id);
    if (!info) return;
    socket.emit('friend_update', { friends: getFriendList(info.guestId), requests: getPendingRequests(info.guestId), unread: getUnreadCounts(info.guestId) });
  });

  socket.on('private_chat_send', ({ to, message }) => {
    const info = onlineSockets.get(socket.id);
    if (!info || !to || !message) return;

    const key = getFriendshipKey(info.guestId, to);
    if (!friendships.has(key)) {
      socket.emit('error_msg', '对方不是好友，无法发送私信');
      return;
    }

    const text = String(message).trim().slice(0, 280);
    if (!text) return;

    addPrivateMessage(info.guestId, to, text);

    const msgObj = { from: info.guestId, to, message: text, ts: Date.now() };

    // 发送给自己
    socket.emit('private_chat_message', msgObj);

    // 发送给对方（如果在线）
    let targetOnline = false;
    for (const [sid, oinfo] of onlineSockets.entries()) {
      if (oinfo.guestId === to) {
        io.to(sid).emit('private_chat_message', msgObj);
        targetOnline = true;
        break;
      }
    }

    // 如果对方不在线，增加未读计数
    if (!targetOnline) {
      incUnread(to, info.guestId);
    }
  });

  socket.on('private_chat_history', ({ with: friendId }) => {
    const info = onlineSockets.get(socket.id);
    if (!info || !friendId) return;
    const history = getPrivateHistory(info.guestId, friendId);
    socket.emit('private_chat_history', { friendId, history });
    clearUnread(info.guestId, friendId);
    socket.emit('friend_update', { friends: getFriendList(info.guestId), requests: getPendingRequests(info.guestId), unread: getUnreadCounts(info.guestId) });
  });

  socket.on('private_chat_read', ({ with: friendId }) => {
    const info = onlineSockets.get(socket.id);
    if (!info || !friendId) return;
    clearUnread(info.guestId, friendId);
    socket.emit('friend_update', { friends: getFriendList(info.guestId), requests: getPendingRequests(info.guestId), unread: getUnreadCounts(info.guestId) });
  });

  // ===== 断开连接 =====
  socket.on('disconnect', () => {
    console.log('[disconnect]', socket.id);
    const info = onlineSockets.get(socket.id);
    if (!info) {
      lastQuickMsg.delete(socket.id);
      onlineSockets.delete(socket.id);
      return;
    }

    // 断线直接踢出（不再有任何45秒保护或重连）
    if (info.tableId) {
      const t = tables.get(info.tableId);
      if (t) {
        const isA = t.playerA && t.playerA.guestId === info.guestId;
        const isB = t.playerB && t.playerB.guestId === info.guestId;

        // 观众直接移除
        if (t.spectators) {
          t.spectators = t.spectators.filter(s => s.guestId !== info.guestId);
        }

        // 坐着的玩家 → 立即清座位
        if (isA) t.playerA = null;
        if (isB) t.playerB = null;

        const wasSeatedPlayer = isA || isB;
        delete t.moves[info.guestId];

        // 只要有坐着的玩家掉线且当前有惩罚任务，就立即清空（防止另一人被无限卡住）
        // 包括单人惩罚和双人平局惩罚
        if (wasSeatedPlayer && t.currentPunishment) {
          t.currentPunishment = null;
          clearPunishmentTimer(info.tableId);
          const sys = addChat(info.tableId, '系统', '系统', '有玩家掉线，惩罚任务已自动清除');
          if (sys) io.to(`table-${info.tableId}`).emit('chat_message', sys);
        }

        if (!t.playerA && !t.playerB) {
          clearPunishmentTimer(info.tableId);
          tables.delete(info.tableId);
        } else {
          const displayName = getDisplayNameForPlayer(info.guestId);
          const sys = addChat(info.tableId, '系统', '系统', `${displayName} 已掉线，退出对局`);
          if (sys) io.to(`table-${info.tableId}`).emit('chat_message', sys);
          broadcastTableUpdate(info.tableId);
        }
        broadcastLobby();
      }
    }

    lastQuickMsg.delete(socket.id);
    if (info && info.guestId) feedbackCooldown.delete(info.guestId);
    onlineSockets.delete(socket.id);
  });
});

// cleanup stale tables every 10 min (optional)
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tables.entries()) {
    if (now - t.lastActivity > 1000 * 60 * 35 && (!t.playerA && !t.playerB)) {
      tables.delete(id);
    }
  }
}, 1000 * 60 * 10);

// ============ HTTP ============
app.get('/api/stats', (req, res) => {
  res.json({
    online: onlineSockets.size,
    totalPlayers: playerStats.size,
    totalRounds: totalRoundsPlayed,
    tables: tables.size,
    recent: matchHistory.slice(0, 8)
  });
});

// 返回更新日志（供前端显示）
app.get('/api/changelog', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const changelogPath = path.join(__dirname, 'CHANGELOG.md');
  try {
    const content = fs.readFileSync(changelogPath, 'utf8');
    res.type('text/markdown').send(content);
  } catch (err) {
    res.status(500).send('无法读取更新日志');
  }
});

const PORT = process.env.PORT || 3456;

// 显式绑定 0.0.0.0，便于服务器外部访问
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ 锤子剪刀布联机服务器已启动`);
  console.log(`   端口: ${PORT}`);
  console.log(`   本地测试: http://localhost:${PORT}`);
  console.log(`   服务器访问: http://你的服务器IP:${PORT}`);
  if (process.env.PORT) {
    console.log(`   (已检测到 PORT 环境变量)`);
  } else {
    console.log(`   生产建议: export PORT=你的端口`);
  }
  console.log(`   注意: 请确保云服务器安全组/防火墙已放行 ${PORT} 端口\n`);
});

// 生产环境常见错误处理（端口被占用、权限不足等）
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${PORT} 已被占用！`);
    console.error(`   解决方法：`);
    console.error(`   1. 换个端口运行：PORT=3000 node server.js`);
    console.error(`   2. 杀死占用进程： lsof -i :${PORT} | grep LISTEN`);
    console.error(`   3. 或者修改代码里的默认端口\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\n❌ 没有权限使用端口 ${PORT}（通常需要 root 或使用 1024 以上端口）\n`);
  } else {
    console.error(`\n❌ 服务器启动失败:`, err);
  }
  process.exit(1);
});