const SteamUser = require("steam-user");
const SteamTotp = require("steam-totp");
const fs = require("fs");
const request = require("request");
const demofile = require("demofile");
const bz2 = require("unbzip2-stream");
const SteamID = require("steamid");
const almostEqual = require("almost-equal");
const GameCoordinator = require("./GameCoordinator.js");
const Decoder = require("./ProtobufDecoder.js");
const config = require("./config.json");

const steamUser = new SteamUser();
const csgoUser = new GameCoordinator(steamUser);
const decoder = new Decoder(csgoUser);

var data = {
	casesCompleted: 0,
	total: {
		startTimestamp: 0,
		endTimestamp: 0
	},
	download: {
		startTimestamp: 0,
		endTimestamp: 0
	},
	unpacking: {
		startTimestamp: 0,
		endTimestamp: 0
	},
	parsing: {
		startTimestamp: 0,
		endTimestamp: 0
	},
	curcasetempdata: {
		sid: undefined,
		owMsg: undefined,
		aimbot_infractions: []
	}
};

var logonSettings = {
	accountName: config.account.username,
	password: config.account.password
};

if (config.account.sharedSecret && config.account.sharedSecret.length > 5) {
	logonSettings.twoFactorCode = SteamTotp.getAuthCode(config.account.sharedSecret);
}

steamUser.logOn(logonSettings);

steamUser.once("loggedOn", () => {
	console.log("Logged in");
	steamUser.setPersona(SteamUser.Steam.EPersonaState.Online);
	steamUser.gamesPlayed([ 730 ]);
	csgoUser.start();
});

steamUser.on("error", (err) => {
	if (csgoUser._GCHelloInterval) clearInterval(csgoUser._GCHelloInterval);

	console.error(err);
});

csgoUser.on("debug", (event) => {
	if (event.header.msg === csgoUser.Protos.EGCBaseClientMsg.k_EMsgGCClientWelcome) {
		data.total.startTimestamp = new Date().getTime();
		console.log("-----------------\nRequested Overwatch case");
		csgoUser._GC.send({
			msg: csgoUser.Protos.ECsgoGCMsg.k_EMsgGCCStrike15_v2_PlayerOverwatchCaseUpdate,
			proto: {}
		}, new csgoUser.Protos.CMsgGCCStrike15_v2_PlayerOverwatchCaseUpdate({
			reason: 1
		}).toBuffer());
		return;
	}

	if (event.header.msg === csgoUser.Protos.ECsgoGCMsg.k_EMsgGCCStrike15_v2_PlayerOverwatchCaseAssignment) {
		var msg = csgoUser.Protos.CMsgGCCStrike15_v2_PlayerOverwatchCaseAssignment.decode(event.buffer);

		if (msg.caseurl) {
			data.curcasetempdata.owMsg = msg;
			data.download.startTimestamp = new Date().getTime();

			// Download demo
			if (fs.existsSync("./demofile.dem")) fs.unlinkSync("./demofile.dem");
			console.log("Downloading case " + msg.caseid + " from url " + msg.caseurl);

			var sid = SteamID.fromIndividualAccountID(msg.suspectid);
			if (!sid.isValid()) {
				console.log("Got invalid suspect ID " + msg.suspectid);
				return;
			}
			data.curcasetempdata.sid = sid;

			var r = request(msg.caseurl);
			r.on("response", (res) => {
				res.pipe(fs.createWriteStream("./demofile.bz2")).on("close", () => {
					data.download.endTimestamp = new Date().getTime();

					// Successfully downloaded, tell the GC about it!
					console.log("Finished downloading " + msg.caseid + ", unpacking...");

					csgoUser._GC.send({
						msg: csgoUser.Protos.ECsgoGCMsg.k_EMsgGCCStrike15_v2_PlayerOverwatchCaseStatus,
						proto: {}
					}, new csgoUser.Protos.CMsgGCCStrike15_v2_PlayerOverwatchCaseStatus({
						caseid: msg.caseid,
						statusid: 1
					}).toBuffer());

					data.unpacking.startTimestamp = new Date().getTime();

					// Parse the demo
					fs.createReadStream("./demofile.bz2").pipe(bz2()).pipe(fs.createWriteStream("./demofile.dem")).on("close", () => {
						data.unpacking.endTimestamp = new Date().getTime();

						fs.unlinkSync("./demofile.bz2");

						data.parsing.startTimestamp = new Date().getTime();

						console.log("Finished unpacking " + msg.caseid + ", parsing as suspect " + sid.getSteamID64() + "...");

						// WARNING: Really shitty aimbot detection ahead!
						fs.readFile("./demofile.dem", (err, buffer) => {
							if (err) return console.error(err);

							data.curcasetempdata.aimbot_infractions = [];

							const demoFile = new demofile.DemoFile();

							// Detect Aimbot
							var lastFewAngles = [];
							demoFile.on("tickend", (curTick) => {
								var ourPlayer = demoFile.players.filter(p => p.steamId !== "BOT" && new SteamID(p.steamId).getSteamID64() === sid.getSteamID64());
								if (ourPlayer.length <= 0) { // User left
									lastFewAngles = [];
									return;
								}
								lastFewAngles.push(ourPlayer[0].eyeAngles);

								if (lastFewAngles.length >= config.parsing.maxTicks) {
									lastFewAngles.shift();
								}
							});

							demoFile.gameEvents.on("player_death", (event) => {
								var attacker = demoFile.entities.getByUserId(event.attacker);
								if (!attacker || attacker.steamId === "BOT" || new SteamID(attacker.steamId).getSteamID64() !== sid.getSteamID64()) {
									return; // Attacker no longer available or not our attacker
								}

								for (let i = 0; i < lastFewAngles.length; i++) {
									// Check pitch
									if (typeof lastFewAngles[i] !== "undefined" && typeof lastFewAngles[i + 1] !== "undefined") {
										if (!almostEqual(lastFewAngles[i].pitch, lastFewAngles[i + 1].pitch, config.parsing.threshold)) {
											if (is360Difference(lastFewAngles[i].pitch, lastFewAngles[i + 1].pitch)) {
												continue;
											}

											data.curcasetempdata.aimbot_infractions.push({ prevAngle: lastFewAngles[i], nextAngle: lastFewAngles[i + 1], tick: demoFile.currentTick });
										}
									}

									// Check yaw
									if (typeof lastFewAngles[i] !== "undefined" && typeof lastFewAngles[i + 1] !== "undefined") {
										if (!almostEqual(lastFewAngles[i].yaw, lastFewAngles[i + 1].yaw, config.parsing.threshold)) {
											if (is360Difference(lastFewAngles[i].yaw, lastFewAngles[i + 1].yaw)) {
												continue;
											}

											data.curcasetempdata.aimbot_infractions.push({ prevAngle: lastFewAngles[i], nextAngle: lastFewAngles[i + 1], tick: demoFile.currentTick });
										}
									}
								}
							});

							demoFile.parse(buffer);

							demoFile.on("end", async (err) => {
								data.parsing.endTimestamp = new Date().getTime();

								if (err.error) {
									console.error(err);
								}

								console.log("Done parsing case " + msg.caseid);

								// Setup conviction object
								var convictionObj = {
									caseid: msg.caseid,
									suspectid: msg.suspectid,
									fractionid: msg.fractionid,
									rpt_aimbot: (data.curcasetempdata.aimbot_infractions.length > config.verdict.maxAimbot) ? 1 : 0,
									rpt_wallhack: 0, // TODO: Add detection for wallhacking
									rpt_speedhack: 0, // TODO: Add detection for other cheats (Ex BunnyHopping)
									rpt_teamharm: 0, // TODO: Add detection of griefing (Ex Afking, Damaging teammates)
									reason: 3
								};

								// Check the Steam Web API, if a token is provided, if the user is already banned, if so always send a conviction even if the bot didn't detect it
								if (config.parsing.steamWebAPIKey && config.parsing.steamWebAPIKey.length >= 10) {
									var banChecker = await new Promise((resolve, reject) => {
										request("https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=" + config.parsing.steamWebAPIKey + "&format=json&steamids=" + sid.getSteamID64(), (err, res, body) => {
											if (err) {
												reject(err);
												return;
											}

											var json = undefined;
											try {
												json = JSON.parse(body);
											} catch(e) {};

											if (json === undefined) {
												reject(body);
												return;
											}

											if (!json.players || json.players.length <= 0) {
												reject(json);
												return;
											}

											resolve(json.players[0]);
										});
									}).catch((err) => {
										console.error(err);
									});

									if (banChecker && banChecker.NumberOfGameBans >= 1 && banChecker.DaysSinceLastBan <= 7 /* Demos are availble for 1 week */) {
										// If the bot didn't catch the suspect aimbotting it is most likely just a waller and nothing else
										convictionObj.rpt_wallhack = 1;

										console.log("Suspect is already banned. Forcefully convicting...");
									} else {
										console.log("Suspect has not been banned yet according to the Steam API");
									}
								}

								if ((data.parsing.endTimestamp - data.parsing.startTimestamp) < (config.parsing.minimumTime * 1000)) {
									// Wait this long before sending the request, if we parse the demo too fast the GC ignores us
									var timer = parseInt((config.parsing.minimumTime * 1000) - (data.parsing.endTimestamp - data.parsing.startTimestamp)) / 1000;

									console.log("Waiting " + parseInt(timer) + " second" + (parseInt(timer) === 1 ? "" : "s") + " to avoid the GC ignoring us");

									await new Promise(r => setTimeout(r, (timer * 1000)));
								}

								// Once we finished analysing the demo send the results
								csgoUser._GC.send({
									msg: csgoUser.Protos.ECsgoGCMsg.k_EMsgGCCStrike15_v2_PlayerOverwatchCaseUpdate,
									proto: {}
								}, new csgoUser.Protos.CMsgGCCStrike15_v2_PlayerOverwatchCaseUpdate(convictionObj).toBuffer());
							});
						});
					});
				});
			});
		} else {
			if (!msg.caseid) {
				// We are still on cooldown
				console.log("We are still on cooldown... Waiting " + (msg.throttleseconds + 1) + " seconds");

				setTimeout(() => {
					data.total.startTimestamp = new Date().getTime();
					console.log("-----------------\nRequested Overwatch case");
					csgoUser._GC.send({
						msg: csgoUser.Protos.ECsgoGCMsg.k_EMsgGCCStrike15_v2_PlayerOverwatchCaseUpdate,
						proto: {}
					}, new csgoUser.Protos.CMsgGCCStrike15_v2_PlayerOverwatchCaseUpdate({
						reason: 1
					}).toBuffer());
				},  ((msg.throttleseconds + 1) * 1000));
				return;
			}

			data.total.endTimestamp = new Date().getTime();
			data.casesCompleted++;

			// Print logs
			console.log("Internal ID: " + data.casesCompleted);
			console.log("CaseID: " + msg.caseid);
			console.log("Suspect: " + (data.curcasetempdata.sid ? data.curcasetempdata.sid.getSteamID64() : 0));
			console.log("Infractions:");
			console.log("	Aimbot: " + data.curcasetempdata.aimbot_infractions.length);
			console.log("	Wallhack: 0");
			console.log("	Other: 0");
			console.log("	Griefing: 0");
			console.log("Timings:");
			console.log("	Total: " + parseInt((data.total.endTimestamp - data.total.startTimestamp) / 1000) + "s");
			console.log("	Download: " + parseInt((data.download.endTimestamp - data.download.startTimestamp) / 1000) + "s");
			console.log("	Unpacking: " + parseInt((data.unpacking.endTimestamp - data.unpacking.startTimestamp) / 1000) + "s");
			console.log("	Parsing: " + parseInt((data.parsing.endTimestamp - data.parsing.startTimestamp) / 1000) + "s");
			console.log("	Throttle: " + msg.throttleseconds + "s");

			if (config.verdict.writeLog) {
				if (!fs.existsSync("./cases")) {
					fs.mkdirSync("./cases");
				}

				// Write case file
				fs.mkdirSync("./cases/" + msg.caseid);
				fs.writeFileSync("./cases/" + msg.caseid + "/message.json", JSON.stringify(data.curcasetempdata.owMsg, null, 4));
				fs.writeFileSync("./cases/" + msg.caseid + "/data.json", JSON.stringify(data, null, 4));
			}

			// Check case limit
			if (config.verdict.maxVerdicts > 0 && data.casesCompleted >= config.verdict.maxVerdicts) {
				console.log("Finished doing " + config.verdict.maxVerdicts + " case" + (config.verdict.maxVerdicts === 1 ? "" : "s"));
				return;
			}

			// Request a overwatch case after the time has run out
			setTimeout(() => {
				data.total.startTimestamp = new Date().getTime();
				console.log("-----------------\nRequested Overwatch case");
				csgoUser._GC.send({
					msg: csgoUser.Protos.ECsgoGCMsg.k_EMsgGCCStrike15_v2_PlayerOverwatchCaseUpdate,
					proto: {}
				}, new csgoUser.Protos.CMsgGCCStrike15_v2_PlayerOverwatchCaseUpdate({
					reason: 1
				}).toBuffer());
			},  ((msg.throttleseconds + 1) * 1000));
		}
		return;
	}

	// Decode all unhandled protobufs if desired
	if (config.other.autoDecode) {
		// Will return a object with:
		// "header", which is the raw default header
		// "matchingHeaders", which an array of all the headers which matched this specific ID
		// "decoded", which is an array of all protobufs applied to the buffer to try and decode it, the ones which failed are not included
		console.log(decoder.decode(event));
	} else {
		console.log(event);
	}
});

// Shitty check for 360 changes
function is360Difference(angle1, angle2) {
	// Check 0 < 360
	if (angle1 <= config.threshold && angle1 >= 0.0 && angle2 <= 360.0 && angle2 >= (360.0 - config.threshold)) {
		return true;
	}

	// Check 360 > 0
	if (angle1 <= 360.0 && angle1 >= (360.0 - config.threshold) && angle2 <= config.threshold && angle2 >= 0.0) {
		return true;
	}

	return false;
}
