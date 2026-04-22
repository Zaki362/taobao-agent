import { MCPAdapter, MCPToolName, MCPToolRequestMap, MCPToolResponseMap } from "@/lib/mcp/types";

type MockCatalogItem = {
  title: string;
  price: number;
  shop_name: string;
  image_url: string;
  detail_url: string;
  shop_badges: string[];
  highlights: string[];
  risk_notes: string[];
};

const MOCK_CATALOG: Record<string, MockCatalogItem[]> = {
  "safety-essential": [
    { title: "4K 超清行车记录仪 夜视增强款", price: 369, shop_name: "途安旗舰店", image_url: "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店", "精选"], highlights: ["前后双录", "停车监控", "新能源适配"], risk_notes: ["安装需要预留走线时间"] },
    { title: "免布线磁吸行车记录仪", price: 239, shop_name: "车载实验室", image_url: "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["安装简便", "循环录制", "紧凑机身"], risk_notes: ["续航更适合短时停车监控"] },
    { title: "流媒体后视镜记录仪升级版", price: 699, shop_name: "极路车品", image_url: "https://images.unsplash.com/photo-1485291571150-772bcfc10da5?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["视野更广", "后录清晰", "高级感强"], risk_notes: ["价格偏高，适合升级预算"] }
  ],
  "cleaning-care": [
    { title: "新车清洁三件套 超细纤维毛巾", price: 59, shop_name: "净驭官方店", image_url: "https://images.unsplash.com/photo-1607860108855-64acf2078ed9?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店", "精选"], highlights: ["性价比高", "覆盖常见清洁需求", "对新手友好"], risk_notes: ["耗材类需要后续补充"] },
    { title: "车用除尘软胶 + 玻璃清洁剂组合", price: 36, shop_name: "车洁坊", image_url: "https://images.unsplash.com/photo-1580273916550-e323be2ae537?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["价格低", "清理缝隙方便", "适合日常保洁"], risk_notes: ["除尘软胶需定期更换"] },
    { title: "高端镀膜养护清洁包", price: 189, shop_name: "曜石养车", image_url: "https://images.unsplash.com/photo-1503736334956-4c8f8e92946d?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["清洁体验更好", "更细致", "适合爱车人士"], risk_notes: ["对首购来说不是绝对刚需"] }
  ],
  "practical-interior": [
    { title: "重力联动手机支架 + 66W 车载快充套装", price: 128, shop_name: "乐行车品", image_url: "https://images.unsplash.com/photo-1517677208171-0bc6725a3e60?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["导航充电一步到位", "稳固不晃", "新能源适用"], risk_notes: ["注意确认出风口结构"] },
    { title: "简约磁吸车载支架停车牌组合", price: 69, shop_name: "鹿途精选", image_url: "https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["价格友好", "安装方便", "日常够用"], risk_notes: ["强颠簸路况稳定性略弱"] },
    { title: "中控隐藏式无线充支架升级套装", price: 268, shop_name: "星航车改", image_url: "https://images.unsplash.com/photo-1617469767053-d3b523a0b982?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店", "精选"], highlights: ["桌面更整洁", "支持快充", "整体感更强"], risk_notes: ["需确认车型兼容性"] }
  ],
  "storage-organization": [
    { title: "折叠后备箱收纳箱 防水耐脏", price: 99, shop_name: "居行好物", image_url: "https://images.unsplash.com/photo-1511919884226-fd3cad34687c?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["实用容量大", "可折叠", "通勤适配"], risk_notes: ["满载时略占空间"] },
    { title: "车载垃圾袋 + 座椅缝隙收纳双件套", price: 45, shop_name: "驾享家", image_url: "https://images.unsplash.com/photo-1508974239320-0a029497e820?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["低成本改善整洁", "安装简单", "适合首购"], risk_notes: ["材质质感偏基础"] },
    { title: "模块化车内整理升级套装", price: 166, shop_name: "木星车生活", image_url: "https://images.unsplash.com/photo-1517048676732-d65bc937f952?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["分区更细", "做工更好", "更整洁"], risk_notes: ["更适合对秩序要求高的用户"] }
  ],
  "comfort-upgrade": [
    { title: "记忆棉头枕腰靠双件套", price: 138, shop_name: "舒驾空间", image_url: "https://images.unsplash.com/photo-1517466787929-bc90951d0974?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["缓解久坐疲劳", "适合通勤", "安装方便"], risk_notes: ["舒适感主观差异较大"] },
    { title: "折叠前挡遮阳挡", price: 39, shop_name: "夏行车品", image_url: "https://images.unsplash.com/photo-1502489597346-dad15683d4c8?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["价格低", "收纳轻便", "夏季实用"], risk_notes: ["尺寸需确认"] },
    { title: "头枕腰靠遮阳三合一升级套装", price: 259, shop_name: "云感驾驶", image_url: "https://images.unsplash.com/photo-1514316454349-750a7fd3da3a?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店", "精选"], highlights: ["体验完整", "整体风格统一", "舒适感提升明显"], risk_notes: ["预算占比更高"] }
  ],
  "decor-ambience": [
    { title: "车载香薰清新套装", price: 49, shop_name: "清风车饰", image_url: "https://images.unsplash.com/photo-1517524206127-48bbd363f3d7?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["气味轻柔", "摆放方便", "提升氛围"], risk_notes: ["对香型敏感用户需谨慎"] },
    { title: "车内氛围灯轻装版", price: 89, shop_name: "夜航车饰", image_url: "https://images.unsplash.com/photo-1517520287167-4bbf64a00d66?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["夜间氛围感强", "安装简单", "颜色可调"], risk_notes: ["不是刚需"] },
    { title: "车内小摆件组合", price: 58, shop_name: "漫游精选", image_url: "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["个性化点缀", "体积小", "容易搭配"], risk_notes: ["不建议放置影响视线的位置"] }
  ],
  "camp-core": [
    { title: "双人快开帐篷 防雨透气款", price: 499, shop_name: "野宿旗舰店", image_url: "https://images.unsplash.com/photo-1504851149312-7a075b496cc7?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["搭建快", "双人适用", "露营起步友好"], risk_notes: ["需确认收纳体积"] },
    { title: "天幕折叠椅基础露营套装", price: 699, shop_name: "山野出行", image_url: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["轻露营够用", "一套起步", "收纳方便"], risk_notes: ["更偏白天场景"] },
    { title: "家庭露营起步四件套", price: 1199, shop_name: "荒野营地", image_url: "https://images.unsplash.com/photo-1470246973918-29a93221c455?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店", "精选"], highlights: ["覆盖更完整", "适合家庭", "省去搭配时间"], risk_notes: ["预算占用较大"] }
  ],
  "camp-sleep": [
    { title: "保暖睡袋 防潮垫组合", price: 289, shop_name: "晚风户外", image_url: "https://images.unsplash.com/photo-1510312305653-8ed496efae75?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["过夜基础", "收纳方便", "新手友好"], risk_notes: ["不同季节保暖等级不同"] },
    { title: "充气垫便携枕头套装", price: 188, shop_name: "山川旅行", image_url: "https://images.unsplash.com/photo-1527631746610-bca00a040d60?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["便携轻量", "提升睡眠体验", "自驾适配"], risk_notes: ["需要充气时间"] },
    { title: "加厚露营睡眠升级套装", price: 469, shop_name: "行野旗舰店", image_url: "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["睡感更好", "更适合过夜", "包裹性强"], risk_notes: ["收纳体积略大"] }
  ],
  "camp-light-power": [
    { title: "露营氛围灯 + 头灯套装", price: 129, shop_name: "营地灯火", image_url: "https://images.unsplash.com/photo-1502082553048-f009c37129b9?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["夜间照明够用", "轻便", "价格友好"], risk_notes: ["电池容量需确认"] },
    { title: "磁吸露营灯 长续航版", price: 169, shop_name: "夜行户外", image_url: "https://images.unsplash.com/photo-1465101046530-73398c7f28ca?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["续航长", "亮度稳定", "适合过夜"], risk_notes: ["亮度更高时耗电更快"] },
    { title: "户外电源轻量起步版", price: 799, shop_name: "野电官方店", image_url: "https://images.unsplash.com/photo-1499906318896-713f7edcdf0f?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["供电稳定", "多场景充电", "适合自驾"], risk_notes: ["预算占比较高"] }
  ],
  "camp-cooking": [
    { title: "卡式炉锅具起步套装", price: 239, shop_name: "野火炊具", image_url: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["起步够用", "收纳方便", "适合简单热食"], risk_notes: ["需另配气罐"] },
    { title: "露营餐具炊具轻量组合", price: 138, shop_name: "山味精选", image_url: "https://images.unsplash.com/photo-1490645935967-10de6ba17061?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["便携", "适合轻露营", "容易清洗"], risk_notes: ["不适合复杂烹饪"] },
    { title: "露营热食升级套组", price: 429, shop_name: "营地厨房", image_url: "https://images.unsplash.com/photo-1482049016688-2d3e1b311543?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["做饭更完整", "收纳箱一体", "适合多人"], risk_notes: ["更适合固定营地"] }
  ],
  "camp-storage": [
    { title: "露营收纳箱耐磨折叠款", price: 139, shop_name: "山野整理", image_url: "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["容量大", "折叠收纳", "搬运方便"], risk_notes: ["满载时偏重"] },
    { title: "装备袋 + 挂物架组合", price: 115, shop_name: "篝火营地", image_url: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["分类方便", "露营现场更整洁", "价格友好"], risk_notes: ["更适合中小型装备"] },
    { title: "折叠推车搬运升级版", price: 359, shop_name: "营地搬运社", image_url: "https://images.unsplash.com/photo-1493962853295-0fd70327578a?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["搬运轻松", "大件友好", "适合自驾"], risk_notes: ["占收纳空间"] }
  ],
  "camp-atmosphere": [
    { title: "露营串灯氛围组合", price: 69, shop_name: "星野灯光", image_url: "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["拍照出片", "氛围感强", "价格低"], risk_notes: ["不是基础刚需"] },
    { title: "露营地毯装饰旗套装", price: 108, shop_name: "漫野生活", image_url: "https://images.unsplash.com/photo-1458442310124-dde6edb43d10?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["营地更完整", "视觉加分", "搭配轻松"], risk_notes: ["实用性较弱"] },
    { title: "露营拍照氛围升级包", price: 188, shop_name: "野趣旗舰店", image_url: "https://images.unsplash.com/photo-1493246507139-91e8fad9978e?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["整体风格统一", "更适合社交露营", "完整度高"], risk_notes: ["优先级可后置"] }
  ],
  "decor-lighting": [
    { title: "暖光玻璃台灯 简约卧室款", price: 169, shop_name: "栖光家居", image_url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["氛围柔和", "适合卧室", "设计感强"], risk_notes: ["注意桌面尺寸"] },
    { title: "床边小夜灯 氛围入门款", price: 59, shop_name: "月白生活", image_url: "https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["低成本提升氛围", "安装简单", "租房友好"], risk_notes: ["亮度更适合作为辅助光"] },
    { title: "落地氛围灯 奶油风升级款", price: 299, shop_name: "云朵照明", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["风格完整", "氛围感强", "适合角落布置"], risk_notes: ["需留出摆放空间"] }
  ],
  "decor-bedside": [
    { title: "床边地毯 温馨短绒款", price: 89, shop_name: "木屿软装", image_url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["触感柔软", "风格百搭", "床边氛围提升"], risk_notes: ["需注意清洁频率"] },
    { title: "小边几床头收纳组合", price: 139, shop_name: "序曲家居", image_url: "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["床边更整洁", "拿取方便", "租房也适合"], risk_notes: ["需确认空间宽度"] },
    { title: "床边舒适软装升级包", price: 259, shop_name: "栖迟生活", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["整体氛围更完整", "更适合休息区域", "风格统一"], risk_notes: ["不是最优先刚需"] }
  ],
  "decor-desk": [
    { title: "桌面收纳盒 + 桌垫组合", price: 79, shop_name: "理想桌面", image_url: "https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["低成本改善桌面", "整洁明显", "新手友好"], risk_notes: ["更适合中小型桌面"] },
    { title: "桌面增高架 原木风", price: 129, shop_name: "桌面研究所", image_url: "https://images.unsplash.com/photo-1497366412874-3415097a27e7?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["层次更清晰", "增加收纳", "风格统一"], risk_notes: ["需确认显示器高度"] },
    { title: "桌面氛围升级套组", price: 239, shop_name: "木感工作室", image_url: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["桌面观感更完整", "适合长期使用", "搭配省心"], risk_notes: ["预算占比更高"] }
  ],
  "decor-storage": [
    { title: "奶油风收纳盒三件套", price: 68, shop_name: "拾间家居", image_url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["整齐感提升", "颜色统一", "容易搭配"], risk_notes: ["容量偏中小"] },
    { title: "免打孔置物架组合", price: 115, shop_name: "归位生活", image_url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["租房友好", "收纳效率高", "安装简单"], risk_notes: ["承重需确认"] },
    { title: "抽屉分隔收纳升级包", price: 88, shop_name: "有序日常", image_url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["杂物更好归类", "适合桌面和床边", "成本低"], risk_notes: ["需要先量尺寸"] }
  ],
  "decor-accent": [
    { title: "装饰画三联画温馨款", price: 118, shop_name: "留白画社", image_url: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["空间更有完成度", "风格鲜明", "适合卧室"], risk_notes: ["需确认墙面和安装方式"] },
    { title: "香薰灯床边装饰组合", price: 96, shop_name: "雾里生活", image_url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["视觉和氛围兼顾", "小空间友好", "适合温馨风格"], risk_notes: ["对香型敏感需谨慎"] },
    { title: "软装摆件升级套组", price: 188, shop_name: "弧光家居", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["搭配省心", "风格统一", "适合快速出效果"], risk_notes: ["更偏风格加分"] }
  ],
  "decor-soft-upgrade": [
    { title: "奶油风床品四件套", price: 219, shop_name: "眠云软装", image_url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["风格完整", "卧室提升明显", "适合长期使用"], risk_notes: ["需确认尺寸"] },
    { title: "轻柔窗帘氛围升级款", price: 189, shop_name: "云帘生活", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["柔化空间光线", "提升观感", "适合卧室"], risk_notes: ["安装方式需确认"] },
    { title: "靠垫地毯软装组合", price: 168, shop_name: "柔感家居", image_url: "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["软装效果明显", "适合补充细节", "温馨感提升"], risk_notes: ["清洁成本更高"] }
  ],
  "dorm-bedding": [
    { title: "宿舍床垫枕头起步套装", price: 199, shop_name: "校园寝居", image_url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["新生友好", "基础够用", "入学高频"], risk_notes: ["需确认宿舍床尺寸"] },
    { title: "宿舍三件套简约款", price: 149, shop_name: "宿舍生活馆", image_url: "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["价格友好", "风格干净", "方便统一"], risk_notes: ["材质舒适度中等"] },
    { title: "睡眠舒适升级四件套", price: 289, shop_name: "青禾寝具", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["舒适感更好", "更适合长期使用", "成套省心"], risk_notes: ["预算占比更高"] }
  ],
  "dorm-study": [
    { title: "宿舍小台灯桌面收纳组合", price: 89, shop_name: "读写生活", image_url: "https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["入学刚需", "桌面更清晰", "夜读友好"], risk_notes: ["需确认插电方式"] },
    { title: "书立桌垫学习三件套", price: 69, shop_name: "课桌研究所", image_url: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["学习效率更高", "收纳更顺手", "预算友好"], risk_notes: ["更适合纸质学习场景"] },
    { title: "桌面学习升级包", price: 158, shop_name: "新学期旗舰店", image_url: "https://images.unsplash.com/photo-1497366412874-3415097a27e7?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["照明更好", "更完整", "适合长期宿舍学习"], risk_notes: ["需确认桌面空间"] }
  ],
  "dorm-storage": [
    { title: "宿舍收纳箱挂钩组合", price: 78, shop_name: "归整校园", image_url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["高频实用", "成本低", "宿舍整洁提升明显"], risk_notes: ["容量需按空间规划"] },
    { title: "脏衣篮抽屉分隔套组", price: 66, shop_name: "宿舍归位社", image_url: "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["使用顺手", "分类简单", "适合女生宿舍"], risk_notes: ["承重一般"] },
    { title: "宿舍收纳升级组合", price: 139, shop_name: "青藤生活", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["模块更完整", "适合长期使用", "搭配省心"], risk_notes: ["需要预留更多空间"] }
  ],
  "dorm-cleaning": [
    { title: "洗漱篮毛巾清洁刷起步套装", price: 58, shop_name: "宿舍清洁坊", image_url: "https://images.unsplash.com/photo-1580273916550-e323be2ae537?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["入学即用", "预算低", "新生友好"], risk_notes: ["耗材需后续补充"] },
    { title: "宿舍洗护轻便组合", price: 46, shop_name: "晨间生活", image_url: "https://images.unsplash.com/photo-1607860108855-64acf2078ed9?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["轻量够用", "适合先补齐", "携带方便"], risk_notes: ["更偏基础款"] },
    { title: "宿舍洗护整理升级包", price: 98, shop_name: "洁净校园", image_url: "https://images.unsplash.com/photo-1503736334956-4c8f8e92946d?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["分类更清楚", "使用顺手", "颜值更高"], risk_notes: ["不是最基础刚需"] }
  ],
  "dorm-daily": [
    { title: "宿舍垃圾桶衣架日用套装", price: 65, shop_name: "新学期百货", image_url: "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["高频刚需", "起步够用", "成本低"], risk_notes: ["材质偏基础"] },
    { title: "宿舍水壶纸巾盒组合", price: 72, shop_name: "校内生活馆", image_url: "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["每天都能用到", "桌面更整洁", "适合补齐"], risk_notes: ["风格较普通"] },
    { title: "宿舍日用升级组合", price: 118, shop_name: "校园优选", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["耐用度更好", "组合更完整", "长期更省心"], risk_notes: ["预算占比更高"] }
  ],
  "dorm-comfort": [
    { title: "坐垫靠垫舒适组合", price: 79, shop_name: "宿舍舒适圈", image_url: "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["日常更舒服", "适合久坐", "补充体验"], risk_notes: ["优先级可后置"] },
    { title: "宿舍小风扇便携款", price: 88, shop_name: "凉感生活", image_url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["夏季实用", "体积小", "桌面友好"], risk_notes: ["功率和噪音需确认"] },
    { title: "宿舍舒适升级包", price: 149, shop_name: "青竹生活", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["体感提升明显", "搭配省心", "适合预算充足"], risk_notes: ["不是最前置刚需"] }
  ],
  "move-cleaning": [
    { title: "搬家清洁起步三件套", price: 79, shop_name: "净屋生活", image_url: "https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["搬家就能用", "成本低", "补齐基础"], risk_notes: ["耗材需要后续补充"] },
    { title: "拖把抹布清洁剂组合", price: 118, shop_name: "入住清洁馆", image_url: "https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["覆盖更完整", "搬家友好", "基础清洁够用"], risk_notes: ["拖把尺寸需确认"] },
    { title: "新居清洁升级包", price: 189, shop_name: "洁净居家", image_url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["使用体验更好", "分类更细", "适合长期使用"], risk_notes: ["预算占比更高"] }
  ],
  "move-kitchen": [
    { title: "厨房起步锅具餐具套装", price: 229, shop_name: "新居厨房", image_url: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["做饭起步够用", "省去搭配时间", "适合一居室"], risk_notes: ["材质和涂层需确认"] },
    { title: "厨房置物架收纳组合", price: 119, shop_name: "厨房归位社", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["台面更整洁", "适合租房", "安装简单"], risk_notes: ["需确认尺寸"] },
    { title: "厨房起步升级包", price: 339, shop_name: "居家小厨旗舰店", image_url: "https://images.unsplash.com/photo-1495521821757-a1efb6729352?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["厨房功能更完整", "更适合长期使用", "质感更好"], risk_notes: ["预算占比更高"] }
  ],
  "move-bathroom": [
    { title: "浴室置物架地垫起步套装", price: 98, shop_name: "清爽卫浴", image_url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["搬家即用", "基础够用", "成本友好"], risk_notes: ["承重需确认"] },
    { title: "洗漱收纳卫生间组合", price: 128, shop_name: "卫浴归整馆", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["卫生间更整洁", "分类方便", "适合小户型"], risk_notes: ["需先量空间"] },
    { title: "卫浴升级整理包", price: 189, shop_name: "沐居旗舰店", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["颜值更高", "使用更顺手", "组合更完整"], risk_notes: ["不是最基础刚需"] }
  ],
  "move-storage": [
    { title: "新居收纳箱抽屉分隔组合", price: 88, shop_name: "归位生活", image_url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["高频实用", "立刻见效", "适合搬家初期"], risk_notes: ["需按区域分配尺寸"] },
    { title: "置物篮挂钩收纳套装", price: 69, shop_name: "有序新居", image_url: "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["收纳灵活", "成本低", "租房友好"], risk_notes: ["承重一般"] },
    { title: "全屋收纳升级套组", price: 169, shop_name: "新家整理所", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["归位效率更高", "适合全屋起步", "搭配省心"], risk_notes: ["需要预留摆放空间"] }
  ],
  "move-daily": [
    { title: "垃圾桶衣架地垫日用套装", price: 86, shop_name: "每日起居", image_url: "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["高频刚需", "价格友好", "搬家友好"], risk_notes: ["风格较基础"] },
    { title: "新居高频日用品组合", price: 109, shop_name: "入住优选", image_url: "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["先补齐刚需", "每天都能用到", "省时间"], risk_notes: ["适配性需按空间确认"] },
    { title: "居家日用升级包", price: 158, shop_name: "好住旗舰店", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["耐用度更好", "组合更完整", "适合长期住"], risk_notes: ["预算占比更高"] }
  ],
  "move-comfort": [
    { title: "床边灯抱枕舒适组合", price: 136, shop_name: "居住舒适圈", image_url: "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["入住体验更好", "适合卧室补充", "风格友好"], risk_notes: ["优先级可后置"] },
    { title: "香薰灯温馨小件套装", price: 92, shop_name: "新居氛围社", image_url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["精选"], highlights: ["氛围感提升", "适合小空间", "轻量补充"], risk_notes: ["不是最基础刚需"] },
    { title: "居住舒适升级包", price: 189, shop_name: "慢住生活", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=80", detail_url: "https://www.taobao.com/", shop_badges: ["旗舰店"], highlights: ["体感提升明显", "适合预算充足", "风格更完整"], risk_notes: ["建议在基础功能补齐后考虑"] }
  ]
};

function findCatalog(moduleId: string, keyword: string) {
  return MOCK_CATALOG[moduleId] ?? Object.entries(MOCK_CATALOG).find(([key]) => keyword.includes(key))?.[1] ?? MOCK_CATALOG["practical-interior"];
}

export const mockMcpAdapter: MCPAdapter = {
  mode: "experimental_local",
  async detect() {
    return {
      available: true,
      message: "未连接用户自己的淘宝 MCP，当前使用演示模式。",
      permissions_scope: ["搜索商品", "浏览商品详情", "提取商品信息", "加入购物车需显式确认"]
    };
  },
  async run<T extends MCPToolName>(tool: T, input: MCPToolRequestMap[T]): Promise<MCPToolResponseMap[T]> {
    if (tool === "search_taobao_products") {
      const searchInput = input as MCPToolRequestMap["search_taobao_products"];
      const results = findCatalog(searchInput.module_id, searchInput.keyword).map((item, index) => ({
        product_id: `${searchInput.module_id}-${index + 1}`,
        title: item.title,
        price: item.price,
        shop_name: item.shop_name,
        image_url: item.image_url,
        detail_url: item.detail_url,
        shop_badges: item.shop_badges,
        highlights: item.highlights
      }));
      return { results } as MCPToolResponseMap[T];
    }

    if (tool === "open_product_detail") {
      const openInput = input as MCPToolRequestMap["open_product_detail"];
      return { opened: true, product_id: openInput.product_id } as MCPToolResponseMap[T];
    }

    if (tool === "extract_product_info") {
      const detailInput = input as MCPToolRequestMap["extract_product_info"];
      const pool = Object.values(MOCK_CATALOG).flat();
      const product = pool.find((item) => detailInput.title && item.title === detailInput.title) ?? pool[0];
      return {
        product_id: detailInput.product_id,
        title: product.title,
        price: product.price,
        shop_name: product.shop_name,
        image_url: product.image_url,
        detail_url: product.detail_url,
        shop_badges: product.shop_badges,
        highlights: product.highlights,
        risk_notes: product.risk_notes
      } as MCPToolResponseMap[T];
    }

    if (tool === "add_to_cart") {
      const cartInput = input as MCPToolRequestMap["add_to_cart"];
      return {
        success: cartInput.confirmed,
        message: cartInput.confirmed ? "已加入购物车（Mock）" : "未确认，已阻止加购",
        product_id: cartInput.product_id
      } as MCPToolResponseMap[T];
    }

    throw new Error(`unsupported tool: ${tool}`);
  }
};
