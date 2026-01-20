//@ts-check
import BasePlugin from "./base-plugin.js";

const [POSITIVE_TYPE, NEGATIVE_TYPE] = ["+", "-"];
const TAG_REGEX = new RegExp(`[${POSITIVE_TYPE}${NEGATIVE_TYPE}][a-zA-Zа-яА-Я_]+`, "gi");

export default class SquadNameRoleBan extends BasePlugin {
  static get description() {
    return "Warn player in squad due their role";
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      tags_settings: {
        required: true,
        example: [
          {
            readable_name: "",
            tags: [],
            role_regex: "",
          },
        ],
      },

      warn_interval: {
        required: true,
        example: 7,
      },

      main_command: {
        required: true,
        example: "tags",
      },

      redis: {
        required: false,
        default: "redis://redis/0",
      },
      persistence_enabled: {
        required: false,
        default: true,
      },
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.checkRoleBySquadName = this.checkRole.bind(this);
    this.isTagWithTypeValid = this.isTagWithTypeValid.bind(this);
    this.isTagValid = this.isTagValid.bind(this);

    this.playerWarnIntervals = new Map();

    this.squadToTagsMap = new DefaultMap(() => new TypedTags(this.isTagWithTypeValid, this.isTagValid));

    this.fullHelpMessages = [
      "Теги отряда запрещают или разрешают роли",
      `Добавление: !${this.options.main_command} +[tag] -[tag]\nОчистка: !${this.options.main_command} clear\nПомощь: !${this.options.main_command} help`,
      "Список доступных тегов:",
    ];

    this.shortHelpMessages = [
      `Добавление: !${this.options.main_command} +[tag] -[tag]\nОчистка: !${this.options.main_command} clear\nПомощь: !${this.options.main_command} help`,
    ];

    this.tagsToTagSettingMap = new Map();

    for (let tag_setting of this.options.tags_settings) {
      for (let tag of tag_setting.tags) {
        this.tagsToTagSettingMap.set(tag.toLowerCase(), tag_setting);
      }

      this.fullHelpMessages.push(`${tag_setting.tags.join(", ")} - ${tag_setting.readable_name}`);
    }
  }

  async mount() {
    this.server.on("PLAYER_ROLE_CHANGE", (data) => {
      if (data.player) {
        this.checkRole(data.player, data.newRole);
      }
    });

    this.server.on("PLAYER_NOW_IS_NOT_LEADER", (data) => {
      if (data.player) {
        this.checkRole(data.player, data.player.role);
      }
    });

    this.server.on("NEW_GAME", (data) => {
      for (let steamID of this.playerWarnIntervals.keys()) {
        this.stopWarns(steamID);
        this.clearAllSquadTags();
      }
    });

    this.server.on(`CHAT_COMMAND:${this.options.main_command}`, (data) => {
      if (data.player) {
        this.commandProcessing(data.player, this.extractCommandArgs(data.message));
      }
    });

    this.server.on(`SQUAD_CREATED`, (data) => {
      if (data.player?.squad) {
        this.fillTagsForSquad(data.player.squad);
      }
    });

    for (let squad of this.server.squads) {
      this.fillTagsForSquad(squad);
    }

    this.verbose(1, "Plugin has been installed");
  }

  async commandProcessing(player, args) {
    if (!player.squad) {
      this.verbose(3, `The player ${player.steamID} call command ${args}, but he hasn't squad`);
      return;
    }

    this.verbose(3, `The player ${player.steamID} call command ${args}`);

    if (player.isLeader) {
      await this.commandLeaderProcessing(player, args);
    } else {
      await this.commandSoldierProcessing(player, args);
    }
  }

  async commandLeaderProcessing(player, args) {
    let [command, ...tags] = args;

    if (command && [POSITIVE_TYPE, NEGATIVE_TYPE].includes(command.slice(0, 1))) {
      await this.setTagsToSquad(player.steamID, player.squad, [command, ...tags]);
      await this.checkAllPlayersInSquad(player.squad);
    } else if (command == "clear") {
      await this.clearSquadTags(player.steamID, player.squad);
      await this.checkAllPlayersInSquad(player.squad);
    } else if (command == "help") {
      await this.showFullHelp(player.steamID);
    } else if (command != "") {
      await this.showShortHelp(player.steamID);
    } else {
      await this.showSquadTags(player.steamID, player.squad);
    }
  }

  async commandSoldierProcessing(player, args) {
    let [command] = args;

    if (command == "help") {
      await this.showFullHelp(player.steamID);
    } else {
      await this.showSquadTags(player.steamID, player.squad);
    }
  }

  async setTagsToSquad(steamID, squad, tags) {
    let squadUniqueID = this.getSquadUniqueID(squad);

    if (!tags) {
      await this.warn(`Введите название тега, ${POSITIVE_TYPE} или ${NEGATIVE_TYPE} обязательны`);
      return;
    }

    let typedTags = new TypedTags(this.isTagWithTypeValid, this.isTagValid);

    let addedTags = [];
    for (let tag of tags) {
      let isTagAdded = typedTags.add(tag);
      if (isTagAdded) {
        addedTags.push(tag);
      }
    }

    if (addedTags.length > 0) {
      this.squadToTagsMap.set(squadUniqueID, typedTags);
      await this.warn(steamID, `Теги установлены: ${addedTags}`);
    } else {
      await this.warns(steamID, [
        `Теги не найдены: ${tags}`,
        `!${this.options.main_command} ${POSITIVE_TYPE}ТЕГ ${NEGATIVE_TYPE}ТЕГ — добавить теги, ${POSITIVE_TYPE} или ${NEGATIVE_TYPE} обязательны`,
      ]);
    }
  }

  async clearSquadTags(steamID, squad) {
    let squadUniqueID = this.getSquadUniqueID(squad);

    this.squadToTagsMap.get(squadUniqueID).clear();
    await this.warn(steamID, "Теги очищены");
  }

  clearAllSquadTags() {
    this.squadToTagsMap.clear();
  }

  async showSquadTags(steamID, squad) {
    let squadUniqueID = this.getSquadUniqueID(squad);

    let tagsWithType = this.squadToTagsMap.get(squadUniqueID).tags();

    if (tagsWithType.length == 0) {
      await this.warn(steamID, "В этом скваде разрешены все роли");
      return;
    }

    let messages = [];
    for (let tagWithType of tagsWithType) {
      let tag = tagWithType.slice(1);
      let type = tagWithType.slice(0, 1);

      let tagSetting = this.tagsToTagSettingMap.get(tag);
      if (!tagSetting) {
        this.verbose(1, `Tag ${tag} not found in tag map`);
        continue;
      }

      messages.push(`${tag} — ${type == POSITIVE_TYPE ? "разрешены" : "запрещены"} '${tagSetting.readable_name}'`);
    }

    await this.warns(steamID, messages);
  }

  async checkRole(player, newRole) {
    if (!this.isNeedToCheckPlayer(player)) {
      this.stopWarns(player.steamID);
      return;
    }

    let squadName = player.squad.squadName;
    let squadUniqueID = this.getSquadUniqueID(player.squad);
    let tagsWithType = this.squadToTagsMap.get(squadUniqueID).tags();

    let { isRoleAllowed, disallowedTag, disallowedTagType, disallowedTagSetting } = this.checkIsRoleAllowedByTags(
      tagsWithType,
      newRole,
      this.tagsToTagSettingMap,
    );

    if (!isRoleAllowed) {
      this.verbose(
        2,
        `The role ${newRole} forbidden for player ${player.steamID} due tags ${tagsWithType}, squad unique id ${squadUniqueID}, squad name ${squadName}`,
      );
      await this.runWarns(
        player.steamID,
        `Роль недоступна в этом отряде!\n\nОтряд помечен как ${disallowedTagType}${disallowedTag}, ${disallowedTagType == POSITIVE_TYPE ? "разрешены" : "запрещены"}: '${disallowedTagSetting.readable_name}'`,
        this.options.warn_interval,
      );
      return;
    }

    this.verbose(
      2,
      `The role ${newRole} not forbidden for player ${player.steamID}, due tags ${tagsWithType}, squad unique id ${squadUniqueID}, squad name ${squadName}`,
    );
    this.stopWarns(player.steamID);
  }

  checkIsRoleAllowedByTags(tagsWithType, role, TagsToTagSettingMap) {
    let isRoleAllowed = true;
    let disallowedTagSetting = null;
    let disallowedTag = null;
    let disallowedTagType = null;

    let previousPositiveSettingAllowed = false;
    for (let tagWithType of tagsWithType) {
      let tag = tagWithType.toLowerCase().slice(1);
      let tagType = tagWithType.toLowerCase().slice(0, 1);

      let tagSetting = TagsToTagSettingMap.get(tag);

      if (!tagSetting) {
        this.verbose(
          3,
          `Found tag ${tag} with type ${tagType} in squad name with tag '${tagsWithType}' but not found setting for it`,
        );
        continue;
      }

      let roleMatch = role.match(tagSetting.role_regex);

      if (tagType == POSITIVE_TYPE && roleMatch) {
        isRoleAllowed = true;
        previousPositiveSettingAllowed = true;
        disallowedTagSetting = null;
        disallowedTag = null;
        disallowedTagType = null;
      } else if (tagType == POSITIVE_TYPE && !roleMatch && !previousPositiveSettingAllowed) {
        isRoleAllowed = false;
        disallowedTagSetting = tagSetting;
        disallowedTag = tagWithType.slice(1);
        disallowedTagType = tagType;
      } else if (tagType == NEGATIVE_TYPE && roleMatch) {
        isRoleAllowed = false;
        disallowedTagSetting = tagSetting;
        disallowedTag = tagWithType.slice(1);
        disallowedTagType = tagType;
      }
    }

    this.verbose(
      3,
      `Role ${role} allowed: ${isRoleAllowed}, readable_setting name ${disallowedTagSetting?.readable_name}`,
    );

    return {
      isRoleAllowed,
      disallowedTag,
      disallowedTagType,
      disallowedTagSetting,
    };
  }

  async checkAllPlayersInSquad(squad) {
    let players = this.server.players.filter(
      (player) => player.teamID == squad.teamID && player.squadID == squad.squadID,
    );

    let promises = [];
    for (let player of players) {
      promises.push(this.checkRole(player, player.role));
    }

    await Promise.all(promises);
  }

  isNeedToCheckPlayer(player) {
    if (!player.squad) {
      this.verbose(2, `Player ${player.steamID} has't squad`);
      return false;
    }

    if (player.squad.locked === "True") {
      this.verbose(2, `Player ${player.steamID} squad ${player.squad.squadID} is locked`);
      return false;
    }

    if (player.isLeader) {
      this.verbose(2, `Player ${player.steamID} is leader of ${player.squad.squadID} squad`);
      return false;
    }

    return true;
  }

  isTagWithTypeValid(tagWithType) {
    if (!tagWithType) {
      return false;
    }

    let type = tagWithType.slice(0, 1);
    if (type != POSITIVE_TYPE && type != NEGATIVE_TYPE) {
      return false;
    }

    let tag = tagWithType.slice(1);
    if (!this.tagsToTagSettingMap.get(tag)) {
      return false;
    }

    return true;
  }

  isTagValid(tag) {
    if (!tag) {
      return false;
    }

    if (!this.tagsToTagSettingMap.get(tag)) {
      return false;
    }

    return true;
  }

  stopWarns(steamID) {
    clearInterval(this.playerWarnIntervals.get(steamID));
  }

  async runWarns(steamID, message, intervalSecond) {
    this.stopWarns(steamID);

    let player = await this.server.getPlayerBySteamID(steamID);

    if (!player || (player && !this.isNeedToCheckPlayer(player))) {
      return;
    }

    await this.warn(steamID, message);

    this.stopWarns(steamID);
    this.playerWarnIntervals.set(
      steamID,
      setInterval(async () => {
        let player = await this.server.getPlayerBySteamID(steamID);

        if (!player || (player && !this.isNeedToCheckPlayer(player))) {
          this.stopWarns(steamID);
          return;
        }

        await this.warn(steamID, message);
      }, intervalSecond * 1000),
    );
  }

  fillTagsForSquad(squad) {
    let squadUniqueID = this.getSquadUniqueID(squad);

    let typedTagsArray = this.squadToTagsMap.get(squadUniqueID);

    for (let tagWithType of this.getAllTagsFromText(squad.squadName.toLowerCase())) {
      this.verbose(3, `${tagWithType} in squad ${squad.squadName}, ${squadUniqueID}`);
      if (this.isTagWithTypeValid(tagWithType)) {
        this.verbose(3, "valid");
        typedTagsArray.add(tagWithType);
      }
    }
  }

  getSquadUniqueID(squad) {
    return `${squad.squadID}_${squad.teamID}_${squad.creatorSteamID}`;
  }

  async showShortHelp(steamID) {
    await this.warns(steamID, this.shortHelpMessages);
  }

  async showFullHelp(steamID) {
    await this.warns(steamID, this.fullHelpMessages);
  }

  async warns(steamID, messages, interval = 3) {
    for (let i = 0; i < messages.length; i++) {
      await this.warn(steamID, messages[i]);

      if (i !== messages.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      }
    }
  }

  async warn(steamID, message) {
    await this.server.rcon.warn(steamID, message);
  }

  extractCommandArgs(text) {
    return text.split(" ").map((value) => value.toLowerCase().trim());
  }

  getAllTagsFromText(text) {
    return Array.from(text.matchAll(TAG_REGEX)).map((value) => value.toString());
  }
}

class TypedTags {
  constructor(tagWithTypeValidator, tagValidator) {
    this._typedTags = [];

    this.tagWithTypeValidator = tagWithTypeValidator;
    this.tagValidator = tagValidator;
  }

  tags() {
    return [...this._typedTags];
  }

  add(tagWithType) {
    if (!this.tagWithTypeValidator(tagWithType)) {
      return false;
    }

    let tag = tagWithType.slice(1);

    let previousTags = this._typedTags.filter((value) => value.slice(1) != tag);
    this._typedTags = [tagWithType, ...previousTags];

    return true;
  }

  delete(tag) {
    if (!this.tagValidator(tag)) {
      return false;
    }

    this._typedTags = this._typedTags.filter((value) => value.slice(1) != tag);

    return true;
  }

  clear() {
    this._typedTags = [];
  }
}

/**
 * @template K, V
 * @extends {Map<K, V>}
 */
class DefaultMap extends Map {
  /**
   * @param {(function(): V) | V} defaultFactory
   * @param {...any} args
   */
  constructor(defaultFactory, ...args) {
    super(...args);

    this.defaultFactory = typeof defaultFactory === "function" ? defaultFactory : () => defaultFactory;
  }

  /**
   * @param {K} key
   * @returns {V}
   */
  get(key) {
    let value = super.get(key);

    if (value === undefined) {
      let defaultValue = this.defaultFactory();
      this.set(key, defaultValue);
      return defaultValue;
    } else {
      return value;
    }
  }
}
