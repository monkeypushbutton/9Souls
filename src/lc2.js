// ==UserScript==
// @name         9Souls
// @namespace    https://github.com/monkeypushbutton/9Souls
// @version      0.1
// @description  An AI for bloodrizer's Kittens Game, capable of performing most actions.
// @author       monkeypushbutton@gmail.com
// @match        https://kittensgame.com/web/*
// @match        https://kittensgame.com/*
// @match        http://kittensgame.com/beta/
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addElement
// @grant        GM_xmlhttpRequest
// @connect      poetrydb.org
// @sandbox      JavaScript
// @require      https://unpkg.com/javascript-lp-solver@0.4.24/prod/solver.js
// @require      https://raw.githubusercontent.com/joshfire/woodman/master/dist/woodman.js
// ==/UserScript==

/*jslint es6 */
/*jslint eval */
/*jslint for:true */
/*jslint todo:true*/

// TODO: Kittens massacre in year 1 due to building too many huts. Sad but not a deal breaker.
// TODO: Pollution. Incentivise not increasing levels.
// TODO: Lazy crafting / trading. Only perform desired crafts when resources near limit, or in process of actually using them
// Rationale: We might happen to improve craft efficiency first and hence will end up being more efficient overall.
// especially noticable with Tears via Ziggurats, but generally seems a sound idea.

// TODO: Check if below TODO is still valid after resCap constraints?
// TODO: LP Still wants to assign kittens to e.g. scientist when resource is at max at certain points. I'm manually correcting for it right now, which sucks.
// TODO: Script is murdering kittens with gay abandon in cold winters. Once that is fixed, reservedNipDays can be reduced.
// TODO: Emergency farming if catnip < reservedAmount & gain per sec < 0
// TODO: shuffle crafts so we don't always prioritise one thing.
// TODO: evaluateProductionStack can't handle ratioIndent, mulltiplier and maybe perYear
// TODO: Check math in variableForPraise Faith is not 1-1 with worship after apocrypha / transcend etc.
// TODO: Check alternative utility for faith unlock in variableForPraiseSun may perform better (it's more consistant at least)
// TODO: Selling things might me beneficial occasionally. e.g. swapping Unicorn Pastures for Ziggurat structures
// Some code for selling exists, but it's a bit buggy.
// TODO: Script doesn't calculate the coal penalty for steamworks correctly. It effects geologists as well as fixed production.
// Script therefore generally overestimates amount of steel it can produce for example.
// TODO: Cleanup and systemitise buidlding functions.
// Building utilities should be inferrable form the description and game knowledge. Not using ad-hoc hardcoding as main way of applying utility tweaks.
// E.g. for resource producers look at how easy it is to generate said resource and factor that in.
// Already have storage utility, but applied inconsistently right now,
// Allow baseUtilityMap to do an array of functions?
// blah blah blah. Trying to get program to work on starcharts / unobtanium is making me mad.

// I'd like to but it interferes with external libraries when plonking script in console.
//"use strict";
var GM_addElement;
var GM_xmlhttpRequest;
var unsafeWindow;
// Allow script to be loaded outside Tampermonkey.
if(!GM_addElement) {
    unsafeWindow = window;
}

unsafeWindow.nineSouls = function() {
    // How long between executions of plan.
    // Setting this too low will be spammy and may slow game.
    // Setting too high may cause missed observations, more 0 / max resource inefficiencies etc.
    // NB: Season is ~ 200 seconds long.
    var executeIntervalSeconds = 5;

    // How much history should we keep?
    var planHistory = 5;
    var purchaseHistory = 50;
    var tradeHistory = 200;

    // How much utility is 10% of happiness worth?
    // Setting this too high will end up in a loop of hunting / festival as soon as unlocked.
    var happinessUtility = 0.05;
    // How much utility is 1% production bonus worth (magneto, solarRevolution, steamworks)
    var globalProductionUtility = 1;
    // Give buildings diminishing returns for building more of them.
    var diminishingReturns = false;
    // Randomly perturb utility values. I don't know why I added this.
    var jiggleUtility = false;
    // Once we switch job assignments this many times (as a percentage of total kittens),
    // optimise job assignments using "Manage Jobs" button
    var reassignmentsBeforeOptimise = 0.5;
    // Amount of catnip to reserve in units of "days of consumption". This should be approximately
    // the number of days we can fall into a new season without replanning, plus a little bit for safety?
    // Or even more for safety if you hate murdering kittens I suppose.
    var reservedNipDays = 100;

    // Somtimes plan will want two things using similar resources.
    // If plan is to buy greater than this number of an item and we have the resources to do so it can be bought.
    // A bird in the hand is worth 1/buyThreshold in the bush so to speak :)
    var buyThreshold = 0.9;

    // Basic incentives to buy things - see also baseUtilityMap for specific incentives
    var baseUtility = 1;
    var faithUtility = 5;
    var scienceUtility = 15;
    var workshopUtility = 12;
    var policyUtility = 2;
    var embassyUtility = 0.25;
    var bldUtility = 0.95;
    var spaceGcUtility = 3;

    // How much additional utility is granted for expanding storage to build things that are currently
    // out of reach (as a multiplier of the basic utility of the infeasible thing)
    var utilityFactorForInfeasible = 0.075;

    // Utility gain per percentage point in "craft effectiveness"
    // Feeds into bonus for workshop/factory and keeping factories powered.
    var utilityForCraftEffectiveness = 0.25;

    // Toggle logic to try and stop script from assiging kittens to dead jobs.
    // May cause longer term deadlocks when science gets evently split between jobs making little progress?
    // 0 = off completely, max amount of resources not considered when planning e.g. job allocation.
    // < 1 Highly not recommended
    // 1 Resources constrainted to max value in utility function.
    // > 1 Multiply resource cap by this and use that as constraint, kind of a half way house.
    var contrainResourceCap = 0;

    // After first reset, which happens after concrete huts, amount of paragon game will attempt
    // to accrue (as a multiple of current paragon). 1 = Reset to double paragon.
    var paragonPerResetRatio = 0.9;

    // If we detect that we can "Adore the Galaxy" and the go on to recover
    // our solar revolution bonus in less than the below amout of time it will
    // trigger a mid-run "Transcend / Adore / Praise" cycle.
    var maxTimeToRecoverWorshipAfterAdoreHours = 8;

    // Latest version of the game this script was tested / developed against.
    // See game.telemetry, checked at startup.
    var supportedVersions = ['1492'];

    var isRunning = false;

    //#region Get references to kittensgame's guts

    var kg = window.game || unsafeWindow.game;

    function ensureKgReference(){
        kg = window.game || unsafeWindow.game;
    }

    //#endregion

    //#region Control Of event loops

    // Do not touch. Used for starting and stopping various recurring activities.
    var eventLoops = {
        execHandle: undefined,
        gatherHandle: undefined
    };

    function go(checkVersion = true) {
        ensureKgReference();
        setupLoggers();
        kg.msg('9Souls: Starting');
        isRunning = true;

        // Important to not stall when choosing a policy upgrade.
        kg.opts.noConfirm = true;

        // Also transcending :-( Ok we're monkey patching I suppose.
        // Transcend (and maybe other places?) unconditionally call game.ui.confirm
        // patch that function to internally check if noConfirm is set and respect it.
        game.ui.nineSoulSafeConfirm = game.ui.confirm;
        kg.ui.confirm = function(title, msg, callbackOk, callbackCancel) {
            if(kg.opts.noConfirm){
                callbackOk();
            } else {
                kg.ui.nineSoulSafeConfirm(title, msg, callbackOk, callbackCancel);
            }
        };

        if(checkVersion && !checkVersionIsTested()){
            return;
        }
        ensureTabsRendered();
        restartExecLoop();
    }

    function checkVersionIsTested() {
        if(supportedVersions.indexOf(kg.telemetry.version) == -1)
        {
            logger.warn("Game version %s does not match tested version %s. Here be dragons. Make a backup and call go(false), or update user script to proceed.",
            kg.telemetry.version,
            testedVersion.version);
            return false;
        }
        return true;
    }

    function stopLoop(handleName){
        if(eventLoops[handleName]){
            clearInterval(eventLoops[handleName]);
            eventLoops[handleName] = undefined;
        }
    }

    function stop(){
        kg.msg("9Souls: Stopping");
        isRunning = false;
        Object.keys(eventLoops).forEach(function(handle){
            if(eventLoops[handle]){
                console.log("Stopping " + handle);
                stopLoop(handle);
            }
        });
    }

    function controlGatherLoop(){
        var nipInfo = kg.resPool.resources[0];
        if(nipInfo.value > 1000 || nipInfo.perTickCached > 2){
            stopLoop('gatherHandle');
        }
        else {
            nineSouls.bePoetic("harvest");
            restartGatherLoop();
        }
    }

    function restartGatherLoop(){
        stopLoop('gatherHandle');
        // ~7 nip per second, about as fast as I can spam click.
        eventLoops.gatherHandle = setInterval(() => kg.bldTab.children[0].buttonContent.click(), 150);
    }

    function restartExecLoop(){
        stopLoop('execHandle');
        executePlanNow();
        eventLoops.execHandle = setInterval(executePlanNow, executeIntervalSeconds * 1000);
    }

    function ensureTabsRendered(){
        kg.villageTab.render();
        kg.libraryTab.render();
        kg.workshopTab.render();
        kg.bldTab.render();
        kg.diplomacyTab.render();
        kg.religionTab.render();
        kg.spaceTab.render();
        kg.timeTab.render();
    }

    //#endregion

    //#region Execution

    function executePlanNow(timesBought = 0){
        execLog.log("Executing");
        executeResetLogic();
        if(!plan){
            planNow();
        }
        if(kg.calendar.season != plannedSeason){
            execLog.log("Replanning (season)");
            planNow();
        }
        if(getBuyables().length != plannedButtons.length){
            //Mainly so we don't have to wait a whole season to build a field :-)
            execLog.log("Replanning (possibilities changed)");
            planNow();
        }
        if(kg.resPool.get("kittens").value != plannedKittens){
            //Mainly so we don't have to wait a whole season to build a field :-)
            execLog.log("Replanning (kittens changed)");
            planNow();
        }
        //console.time("executePlan");
        executeTrades();
        executeHunts();
        executeCrafts();

        observeTheSky();
        controlGatherLoop();

        executeSellItems();
        executeIncrementableBuilding();
        executeToggleBuildings();

        praiseUnderPlan();
        sacrificeUnderPlan();

        assignJobs();
        executeFestival();
        promoteUnderPlan();
        considerUpgrade();
        executeExplore();
        doLeaderChangeTrait("manager");

        var bought = false;
        if(timesBought < 5){
            bought = buyUnderPlan();
        }
        //console.timeEnd("executePlan");
        if(bought){
            execLog.log("Replanning (bought something)");
            planNow();
            executePlanNow(timesBought + 1);
        }
        updateUi();
    }

    function observeTheSky(){
        if(kg.calendar.observeBtn){
            nineSouls.bePoetic("new star");
            execLog.log("Observing...");
            kg.calendar.observeBtn.click();
        }
    }

    //#endregion

    //#region Plan
    var plan;
    var model;
    var executedPlan;
    var historicPlans = new CircularBuffer(planHistory);
    var historicModels = new CircularBuffer(planHistory);
    var historicExecution = new CircularBuffer(purchaseHistory);
    var historicTrades = new CircularBuffer(tradeHistory);

    // We use these variables to track if we need to replan. Do not change.
    var plannedSeason = -1;
    var plannedKittens = 0;
    var plannedButtons = [];
    var reservedFarmers = 0;

    function planNow(){
        plannedSeason = kg.calendar.season;
        plannedButtons = getBuyables();
        plannedKittens = kg.resPool.get("kittens").value;
        model = buildModel();
        historicModels.push(plan);
        const timeEnterSolve = performance.now();
        plan = window.solver.Solve(model);
        if(!plan.feasible || !plan.bounded){
            logger.error("Generated model produced an infeasible or unbounded plan. Quitting so you can debug it.");
            stop();
        }
        const timeExitSolve = performance.now();
        logger.log("%s took %ims", "solver.Solve", timeExitSolve - timeEnterSolve);
        historicPlans.push(plan);
        if(executedPlan){
            executedPlan.validTo = new Date();
            historicExecution.push(executedPlan);
        }
        executedPlan = {validFrom: new Date()};
        logger.info(model);
        logger.info(plan);
        updatePlanUi();
    }

    function planHorizonSeconds(){
        return (100 - kg.calendar.day) * 2;
    }

    function secretUnlocks() {
        // NB: Most of these are now implemented by adding a utility to the action we want to take at a certain point
        // e.g. refine wood early game, assign a kitten to minerals etc etc.

        // What other secrets are out there!?
        return [];
    }

    function limitedResources(btn){
        //console.log(buttonId(btn), btn)
        var limitedResourcesArr = [];
        btn.model.prices.forEach(function(cost){
            var resMax = kg.resPool.get(cost.name).maxValue;
            if(cost.name == "catnip"){
                resMax -= reservedNipAmount();
            }
            if(resMax && resMax < cost.val){
                limitedResourcesArr.push(cost);
            }
        });
        return limitedResourcesArr;
    }

    function isFeasible(btn){
        return limitedResources(btn).length == 0 || canSwapLeaderToPurchase(btn) != null;
    }

    function canAffordNow(btn){
        return canAffordHowManyNow(btn) >= 1;
    }

    function isScienceButton(btn){
        return btn.tab && btn.tab.tabId == "Science";
    }

    function isFaithButton(btn){
        if(btn.model && btn.model.metadata){
            return kg.religion.religionUpgrades.find((ru) => ru.name == btn.model.metadata.name);
        }
        return false;
    }

    function isBuilding(btnId){
        return kg.bld.buildingsData.find((b) => buttonId(b) == btnId);
    }

    function isWorkshopButton(btn){
        return btn.tab && btn.tab.tabId == "Workshop";
    }

    function isGcButton(btn){
        return kg.space.programs.find((p) => p.name == buttonId(btn)) != null;
    }

    function canAffordHowManyNow(btn){
        //console.debug("Checking if I can afford ", buttonId(btn))
        return btn.model.prices.reduce(function(limitedAmount, pe){
            const reservedRes = pe.name == "catnip" ? reservedNipAmount() : 0;
            const needed = pe.val * leaderDiscountRatio(btn, pe.name);
            const resPoolRes = kg.resPool.resourceMap[pe.name].value;
            const availableResources = Math.max(resPoolRes - reservedRes, 0);
            const ratio = availableResources / needed;
            //console.debug("I have enough ", pe.name, " need ", pe.val, " have ", resPoolRes)
            return Math.min(ratio, limitedAmount);
        }, Infinity);
    }

    function buildModel() {
        const timeEnter = performance.now();
        model = {
            optimize: "utility",
            opType: "max",
            variables: {},
            constraints: {},
            planFor: planHorizonSeconds()
        };
        var outOfReach = getBuyables(false);
        for(const btn of getBuyables()){
            var buyVariable = variableFromButton(btn, outOfReach);
            model.variables[buyVariable.name] = buyVariable;
        }
        // for(var sellBtn of getSellable()){
        //     var sellVariable = variableFromSellable(sellBtn, outOfReach);
        //     model.variables[sellVariable.name] = sellVariable;
        //     model.constraints[buttonId(sellBtn) + "Sell"] = { max: 1 };
        // }
        for(const job of getJobAssignments()){
            var jobVariable = variableFromJobAssignment(job);
            model.variables[jobVariable.name] = jobVariable;
        }
        for(var race of getTradeableRaces()){
            var tradeVariable = variableFromTrade(race, outOfReach);
            model.variables[tradeVariable.name] = tradeVariable;
        }
        for(var craftBtn of getCrafts()){
            var craftVariable = variableFromCraft(craftBtn, outOfReach);
            model.variables[craftVariable.name] = craftVariable;
        }
        for(var incrementableBld of getIncrementableBuildings()){
            var bldName = buttonId(incrementableBld);
            var bldNumVar = variableFromIncrementableBuilding(incrementableBld);
            model.variables[bldNumVar.name] = bldNumVar;
            model.constraints[bldName] = { max: incrementableBld.val };
        }
        for(var toggleBld of getToggleableBuildings()){
            var tglBldName = buttonId(toggleBld);
            var tglBldNumVar = variableFromToggleableBuilding(toggleBld);
            model.variables[tglBldNumVar.name] = tglBldNumVar;
            model.constraints[tglBldName] = { max: 1 };
        }
        for(var res of kg.resPool.resources) {
            if(res.name == "catnip"){
                var emergencyNip = reservedNipAmount();
                model.constraints[res.name] = {
                    max: Math.max(projectResourceAmount(res) - emergencyNip, 0)
                }
            } else {
                model.constraints[res.name] = {
                    max: projectResourceAmount(res)
                }
            }
            if(res.maxValue && contrainResourceCap){
                model.constraints[res.name + "Cap"] = {
                    max: res.maxValue * contrainResourceCap
                }
            }
        }
        var promoteVariable = variableForPromoteLeader();
        if(promoteVariable){
            model.variables[promoteVariable.name] = promoteVariable;
            model.constraints.promotion = {max: 1};
        }
        for(var huntVariable of variableFromHunt()) {
            model.variables[huntVariable.name] = huntVariable;
            if(huntVariable.huntForLuxury){
                model.constraints.huntForLuxury = {max: huntVariable.huntForLuxuryMax};
            }
        }
        var exploreVar = variableFromExplore();
        if(exploreVar){
            model.constraints[exploreVar.name] = {min: 0, max: 1}
            model.variables[exploreVar.name] = exploreVar;
        }
        var praiseSunVar = variableForPraiseSun();
        if(praiseSunVar){
            model.variables[praiseSunVar.name] = praiseSunVar;
        }
        var sacVariable = variableForSacrifice();
        if(sacVariable){
            model.variables[sacVariable.name] = sacVariable;
        }
        var festVariable = variableForFestival();
        if(festVariable){
            model.variables[festVariable.name] = festVariable;
            model.constraints.festivalCap = 1;
        }
        if(kg.science.get("electricity").researched){
            model.constraints.energy = {max: 0 - nondispatchableEnergyConsumption()}
        }
        reservedFarmers = reserveFarmers();
        model.constraints.kittens.max -= reservedFarmers;
        const timeExit = performance.now();
        logger.log("%s took %ims", "buildModel", timeExit - timeEnter);
        return model;
    }

    function nondispatchableEnergyConsumption(){
        return kg.bld.meta[0].meta.filter(m => !m.togglable).reduce((total, b) => total + b.totalEffectsCached.energyConsumption, 0)
    }

    function segmentPlan(p = plan){
        var sp = {};
        var notCopied = ["bounded", "feasible", "isIntegral", "result"];
        for(var f in p){
            if(notCopied.find(nc => nc == f)){
                continue;
            }
            var parts = f.split("|");
            if(parts.length == 1){
                sp[f] = p[f];
            } else {
                if(!sp[parts[0]]){
                    sp[parts[0]] = {};
                }
                sp[parts[0]][parts[1]] = p[f];
            }
        }
        return sp;
    }

    //#endregion Plan

    //#region Buyables

    function upgradeButton(btn){
        kg.msg('9Souls: Upgrading ' + buttonLabel(btn));
        bePoetic("upgrade");
        if(btn.model.showSellLink){
            var sellLink = btn.sellHref.link;
            var number = btn.model.metadata.val;
            for(var sellIdx = 0; sellIdx < number; sellIdx++){
                sellLink.click();
            }
        }
        btn.stageLinks[btn.stageLinks.length - 1].link.click();
        planNow();
    }

    function doubleCheckUpgradeAvailable(btn){
        return btn.model.metadata.stage == 0 && btn.model.metadata.stages[1].stageUnlocked;
    }

    function considerUpgrade(){
        if(kg.science.get("electronics").researched){
            // Broadcast Tower is vg - just upgrade.
            var ampiBtn = kg.bldTab.children.find(b => buttonId(b) == "amphitheatre");
            if(doubleCheckUpgradeAvailable(ampiBtn)){
                // Ok to upgrade.
                upgradeButton(ampiBtn);
            }
            var libraryButton = kg.bldTab.children.find(b => buttonId(b) == "library");
            // I think this upgrade should happen with uplink so that we get immediate boost to max science etc effectiveness.
            if(kg.workshop.get("uplink").researched){
                if(doubleCheckUpgradeAvailable(libraryButton)){
                    // Ok to upgrade.
                    upgradeButton(libraryButton);
                }
            }
        }
        if(kg.science.get("ecology").researched){
            var pastureBtn = kg.bldTab.children.find(b => buttonId(b) == "pasture");
            // Upgrade when we start hitting an energy crisis.
            if(kg.resPool.energyProd - kg.resPool.energyCons < 5 ){
                if(doubleCheckUpgradeAvailable(pastureBtn)){
                    // Ok to upgrade.
                    upgradeButton(pastureBtn);
                }
            }
        }
        if(kg.science.get("robotics").researched){
            var aqueductBtn = kg.bldTab.children.find(b => buttonId(b) == "aqueduct");
            // Upgrade when we start hitting an energy crisis again after solar farm is upgraded
            if(
                kg.resPool.energyProd - kg.resPool.energyCons < 5 &&
                kg.bld.get("pasture").stage != 0
                ){
                if(doubleCheckUpgradeAvailable(aqueductBtn)){
                    // Ok to upgrade.
                    upgradeButton(aqueductBtn);
                }
            }
        }
    }

    function getBuyables(feasible = true) {
        //console.time("getBuyables");
        // console.time("bldTab.render");
        // gamePage.bldTab.render();
        // console.timeEnd("bldTab.render");
        var buyable = kg.bldTab.children.slice(2).filter(b =>
            isFeasible(b) == feasible && (
                !planningForResetSince ||
                b.model.metadata.effects.maxKittens ||
                kg.bldTab.bldGroups.find(bg => bg.group.name == "storage").group.buildings.find(build => build == buttonId(b))
            )
        );
        if(kg.spaceTab.visible){
            if(!planningForResetSince){
                buyable = buyable.concat(kg.spaceTab.GCPanel.children.filter(btn =>
                    btn.model.visible &&
                    (btn.model.metadata.val == 0 || !btn.model.metadata.noStackable) &&
                    isFeasible(btn) == feasible));
            }
            buyable = buyable.concat(
                kg.spaceTab.planetPanels
                    .flatMap(pp => pp.children)
                    .filter(btn =>
                        btn.model.visible
                        && isFeasible(btn) == feasible
                        && (!planningForResetSince || btn.model.metadata.effects.maxKittens))
            );
        }

        if(planningForResetSince)
            return buyable;

        if(kg.workshopTab.visible){
            // gamePage.workshopTab.render();
            buyable = buyable.concat(kg.workshopTab.buttons.filter(b => b.model.visible && isFeasible(b) == feasible && !b.model.metadata.researched));
        }
        if(kg.libraryTab.visible){
            // console.time("libraryTab.render");
            // kg.libraryTab.render();
            // console.timeEnd("libraryTab.render");
            buyable = buyable.concat(kg.libraryTab.buttons.filter(b => b.model.visible && isFeasible(b) == feasible && !b.model.metadata.researched));
            if(kg.libraryTab.policyPanel.visible){
                buyable = buyable.concat(kg.libraryTab.policyPanel.children.filter(b => b.model.visible && isFeasible(b) == feasible && !b.model.metadata.researched && !b.model.metadata.blocked))
            }
        }
        if(kg.diplomacyTab.visible){
            // kg.diplomacyTab.render();
            buyable = buyable.concat(kg.diplomacyTab.racePanels.map(rp => rp.embassyButton).filter(b => b.model.visible && isFeasible(b) == feasible));
        }
        if(kg.religionTab.visible){
            // kg.religionTab.render();
            buyable = buyable.concat(kg.religionTab.rUpgradeButtons.filter(btn => btn.model.visible && isFeasible(btn) == feasible && !(btn.model.metadata.noStackable && btn.model.metadata.val != 0 )));
            if(kg.bld.get("ziggurat").val > 0){
                buyable = buyable.concat(kg.religionTab.zgUpgradeButtons.filter(zu => zu.model.visible && isFeasible(zu) == feasible))
            }
        }
        if(kg.libraryTab.metaphysicsPanel.visible){
            buyable = buyable.concat(
                kg.libraryTab.metaphysicsPanel.children.filter(mp => mp.model.visible)
            );
        }
        buyable = buyable.concat(secretUnlocks());
        //console.timeEnd("getBuyables");
        return buyable;
    }

    function variableFromButton(btn, outOfReach){
        //buyableLog.log(btn, outOfReach);
        const variable = {
            name: "Build|" + buttonId(btn),
            utility: buttonUtility(btn, outOfReach)
        }
        for(pe of btn.model.prices){
            const price = pe.val * leaderDiscountRatio(btn, pe.name);
            variable[pe.name] = price;
            if(contrainResourceCap)
                variable[pe.name + "Cap"] = price;
        }
        return variable;
    }

    // Some buildings are just really good and some are real stinkers in the context of this script.
    var baseUtilityMap = {
        // Workshop
        // What's an engineer???
        factoryOptimization: 0.1,
        factoryRobotics: 0.1,
        // We don't use automation. Script too good at crafting.
        factoryAutomation: 0.1,
        advancedAutomation: 0.1,
        pneumaticPress: 0.1,
        // Meh - not like we miss them anyway.
        seti: 0.2,
        barges: 0.2,
        // Factories are heckin expensive.
        carbonSequestration: btn => btn.model.metadata.val == 0 ? 1 : 10,
        // I hate zebras for good reason
        oxidation: 15,

        // Making more huts is v.g.
        ironwood: 20,
        concreteHuts: 20,
        unobtainiumHuts: 20,
        eludiumHuts: 20,

        // Trade
        // Incentivise sharks over lizards. Manuscripts for early game.
        sharksEmbassy: 0.7,

        // Science
        // In game description is accurate.
        socialism: 0.0001,
        // Bloody thespians
        drama: 1,
        // Bloody hippies
        ecology: 4,

        // Policies
        // https://wiki.kittensgame.com/en/guides-and-advice-and-stuff/monstrous-advice
        tradition: 1.5,
        clearCutting: 1.5,
        monarchy: 1.1,
        epicurianism: 1.1,

        // Faith
        templars: 2,
        apocripha: 12,
        solarRevolution: 12,
        ivoryTower: 6,

        // Bonfire
        // Nip production is ass outside the very early game.
        field: 0.6,
        pasture: 0.5,
        aqueduct: 0.6,

        // Only way to improve starchart production early game.
        observatory: 1.15,

        // Pop
        // Highly useful - pretty much always
        hut: 5,
        logHouse: 2.5,
        mansion: 2.5,
        // Storage
        // Additional storage not that useful. We hopefuly aren't going to hover max resources with this script.
        barn: 0.5,
        warehouse: 0.5,
        harbor: 0.5,
        // Hunting is just more a straight up more efficient use of manpower.
        mint: 0.3,
        // Production
        magneto: 1.5,
        reactor: 1.5,
        smelter: 1.5,
        unicornPasture: 0.5,

        mine: (btn) => firstTimesTheCharm(btn, 1),
        workshop: (btn) => firstTimesTheCharm(btn, utilityForCraftEffectiveness * 6),
        library: (btn) => firstTimesTheCharm(btn, 1),
        temple: (btn) => firstTimesTheCharm(btn, 1),

        // Space
        // Starcharts are a huuge bottleneck.
        sattelite: (btn) => firstTimesTheCharm(btn, 3),
        spaceElevator: 4,
        spaceStation: 2,
        // Redmoon
        moonOutpost: (btn) => firstTimesTheCharm(btn, 2),
        moonBase: 0.3

        //faithTab: [faithUtility, ]
    };

    function isPolicy(btn){
        const btnId = (typeof btn == 'object') ? buttonId(btn) : btn;
        return kg.science.policies.find(p => p.name == btnId)
    }

    function isMetaphysics(btn){
        const btnId = buttonId(btn);
        if(btnId == "Burn your paragon"){
            return true;
        }
        if(game.prestige.perks.find(p => p.name == btnId)){
            return true;
        }
        return false;
    }

    // Bonus for buildings where the first is important.
    function firstTimesTheCharm(btn, base){
        if(btn.model.metadata.val == 0){
            buyableLog.log("%s: Incentive applied for first building %f", buttonId(btn), (base * 2.5).toFixed(2));
        }
        else {
            return base;
        }
        return btn.model.metadata.val == 0 ? 2.5 : 1;
    }

    // prestige.js getParagonProductionRatio 501
    function getParagonProductionRatio(paragon, burnedParagon){
        var paragonRatio = kg.prestige.getParagonRatio();

        var productionRatioParagon = (paragon * 0.010) * paragonRatio;
        productionRatioParagon = kg.getLimitedDR(productionRatioParagon, 2 * paragonRatio);

        var ratio = kg.calendar.darkFutureYears() >= 0 ? 4 : 1;
        var productionRatioBurnedParagon = burnedParagon * 0.010 * paragonRatio;
        productionRatioBurnedParagon = kg.getLimitedDR(productionRatioBurnedParagon, ratio * paragonRatio);

        return productionRatioParagon + productionRatioBurnedParagon;
    }

    function globalProdParagonProductionCost(btn){
        var para = paragonCost(btn);
        if(para == 0){
            return 0;
        }
        var paragonNow = game.resPool.get("paragon").value;
        var burnedParagonNow = game.resPool.get("paragon").value;
        var productionBonusNow = getParagonProductionRatio(paragonNow, burnedParagonNow);

        var paragonAfter = paragonNow - para;
        var burnedParagonAfter = burnedParagonNow + (buttonId(btn) == "Burn your paragon" ? para : 0);
        var productionBonusAfter = getParagonProductionRatio(paragonAfter, burnedParagonAfter);
        return productionBonusNow - productionBonusAfter;
    }

    function paragonCost(btn){
        if(!isMetaphysics(btn)){
            return 0;
        }
        if(buttonId(btn) == "Burn your paragon")
            return game.resPool.get("paragon").value;
        return btn.model.prices.find(p => p.name == "paragon").val;
    }

    function buttonUtility(btn, outOfReach = null){
        var id = buttonId(btn)
        // Faith upgrades are pretty important, as are science and workshop.
        // Incentivise them as they tend to look expensive to the optimiser.
        var mappedUtility = baseUtilityMap[id];
        var utility = baseUtility;
        if (typeof mappedUtility === 'function') {
            buyableLog.log("Calling mappedUtility function");
            switch (mappedUtility.length){
                case 0:
                    utility = mappedUtility();
                    break;
                case 1:
                    utility = mappedUtility(btn);
                    break;
                case 2:
                    utility = mappedUtility(btn, outOfReach);
                    break;
                default:
                    buyableLog.warn("Too many arguments for utility function!");
            }
        } else if (!(mappedUtility === undefined)) {
            utility = mappedUtility;
        } else if(isFaithButton(btn)){
            utility = faithUtility;
        } else if(isScienceButton(btn)){
            utility = scienceUtility;
        } else if(isWorkshopButton(btn)){
            utility = workshopUtility;
        } else if (isPolicy(btn)) {
            utility = policyUtility;
        } else if (isGcButton(btn)) {
            utility = spaceGcUtility;
        } else if (isMetaphysics(btn)) {
            utility = 25 - (globalProdParagonProductionCost(btn) * globalProductionUtility * 100);
        }
        // Embassies have diminishing returns.
        else if(btn.race){
            utility = embassyUtility;
            buyableLog.log("%s: Embassy base utility %f", id, utility.toFixed(2));
            const builtAlready = btn.model.metadata.val;
            if(btn.race.sells.find(s => s.minLevel && s.minLevel > builtAlready)){
                utility *= 1.6;
                buyableLog.log("%s: Bonus applied for unlocking goods %f", id, utility.toFixed(2));
            }
            if(diminishingReturns){
                utility = utility - (diminishingReturns ? kg.getLimitedDR(builtAlready, utility) : 0);
                buyableLog.log("%s: Penalty for diminishing returns applied %f", id, utility.toFixed(2));
            }
        }
        else if(isBuilding(id)) {
            var baseutility = mappedUtility || bldUtility;
            if(id == "steamworks"){
                if(kg.bld.get("magneto").val > 0){
                    baseutility = 1.2
                    buyableLog.log("%s: Steamworks specific logic (post magneto) baseutility: %f", id, baseutility.toFixed(2));
                } else if (kg.workshop.get("printingPress").researched) {
                    baseUtility = 0.8
                    buyableLog.log("%s: Steamworks specific logic (post printingPress) baseutility: %f", id, baseutility.toFixed(2));
                } else {
                    baseutility = 0.2;
                    buyableLog.log("%s: Steamworks specific logic (naked) baseutility: %f", id, baseutility.toFixed(2));
                }
            }
            buyableLog.log("%s: Base utility: %f", id, baseutility.toFixed(2));

            var craftEffect = btn.model.metadata.effects.craftRatio || 0;
            if(craftEffect){
                var craftUtility = craftEffect * 100 * utilityForCraftEffectiveness;
                baseutility += craftUtility;
                buyableLog.log("%s: Bonus utility for craft ratio %f, utility %f, new utility %f", id, craftEffect.toFixed(2), craftUtility.toFixed(2), baseutility.toFixed(2));
            }

            if (id == "oilWell") {
                //logger.log(id);
                var oil = kg.resPool.get("oil");
                if(oil.value == oil.maxValue){
                    baseutility = baseutility / 2;
                    buyableLog.log("%s: Penalty applied for produced resource maxxed %f", id, baseutility.toFixed(2));
                }
            }
            // already not using all of building x, disincentivise
            if(btn.model.metadata.val > btn.model.metadata.on){
                baseutility = baseutility / 2;
                buyableLog.log("%s: Penalty applied for not all in use %f", id, baseutility.toFixed(2));
            }

            // Give them diminishing returns to incentivise climbing the tech tree faster.
            if(diminishingReturns){
                const builtAlready = btn.model.metadata.val
                utility = baseutility - kg.getLimitedDR(builtAlready, baseutility);
                buyableLog.log("%s: %i Discounted utility: %f", id, builtAlready, utility.toFixed(2));
            } else {
                utility = baseutility;
            }
            // Storage buildings are more useful than they appear naively, beacause we want to push up the tech tree for example.
            if(outOfReach && Object.keys(btn.model.metadata.effects).find(e => e.endsWith("Max") || e.endsWith("MaxRatio")) ){
                const additionalUtility = utilityForSorageCap(id , outOfReach, btn.model.metadata.effects);
                buyableLog.log("%s: %f additional utility for storage cap: %f", id, additionalUtility.toFixed(2), utility.toFixed(2));
                utility += additionalUtility
                //logger.log(id, utility);
            }
            //logger.log(id, utility);
        }

        // Jittery
        if(jiggleUtility)
            utility = utility * (1 + Math.random() / 10);
        //buyableLog.log("%s: Final utility including jitter %s", id, utility.toFixed(4))
        //if(outOfReach)
            // console.timeEnd("buttonUtility")
        return utility;
    }

    function debugButtonUtility(btnName){
        const btn = getBuyables().find(b => buttonId(b) == btnName);
        if(!btn){
            return "Unknown button " + btnName;
        }
        const oor = getBuyables(false);
        return debug(() => buttonUtility(btn, oor), buyableLog);
    }

    // Work in progress
    function allProductionMaxxed(model){
        if(!model)
            return false;
        if(!model.metadata)
            return false;
        if(!model.metadata.effects)
            return false;
        var productionEffects = Object.keys(model.metadata.effects).filter(e => e.endsWith("PerTickBase") && model.metadata.effects[e] > 0);
        if(productionEffects.length == 0)
            return false;

        for(var eff of productionEffects)
        {
            var resName = eff.substring(0, eff.indexOf("PerTickBase"));
            var res = kg.resPool.get(resName);
            if(res.value < res.maxValue)
                return false;
        }
        return true;
    }

    function utilityForSorageCap(id, outOfReach, effects){
        var utility = 0;
        for(var infeasible of outOfReach){
            for(var price of infeasible.model.prices){
                const resource = kg.resPool.get(price.name);
                if( resource.maxValue < price.val ){
                    const extraCap = price.val - resource.maxValue;
                    const currentRatioEffect = 1 + kg.getEffect(resource.name + "MaxRatio");
                    var capIncrease = (effects[resource.name + "Max"] || 0) * currentRatioEffect;
                    capIncrease *= 1 + kg.prestige.getParagonStorageRatio();
                    const capIncreaseRatio = effects[resource.name + "MaxRatio"] || 0;
                    if(!capIncrease && !capIncreaseRatio)
                        continue;
                    if(capIncreaseRatio){
                        var maxWithNoRatioEffect = resource.maxValue / currentRatioEffect;
                        var capWithOneRatioEffect = maxWithNoRatioEffect * (1 + capIncreaseRatio);
                        var extraCapForRatio = capWithOneRatioEffect - maxWithNoRatioEffect;
                        capIncrease += extraCapForRatio;
                    }
                    var percentOfRequired = Math.min(capIncrease / extraCap, 1);
                    if(percentOfRequired > 0){
                        var infeasibleUtility = buttonUtility(infeasible) * utilityFactorForInfeasible;
                        var extraUtility = infeasibleUtility * percentOfRequired;
                        utility += extraUtility;
                        buyableLog.log(
                            "%s: Contributes %f %s of %f needed for %s (utility %f) for %f extra utility. utilityForSorageCap %f",
                            id,
                            capIncrease.toFixed(1),
                            resource.name ,
                            extraCap.toFixed(1) ,
                            buttonId(infeasible),
                            infeasibleUtility.toFixed(4),
                            extraUtility.toFixed(4),
                            utility.toFixed(4))
                    }
                }
            }
        }
        return utility;
    }

    function buyUnderPlan(){
        bought = false
        var allBuyable = getBuyables();
        for(buyable in plan){
            if(!buyable.startsWith('Build'))
                continue;
            var numToBuy = plan[buyable];
            if(numToBuy < buyThreshold)
                continue;
            var label = buyable.slice(6);
            var buyButtons = allBuyable.filter(b => buttonId(b) == label);
            if(buyButtons.length != 1){
                buyableLog.warn("Unknown or ambiguous buyable " + buyable + " this action cannot be performed at this time.");
                continue;
            }
            buyButton = buyButtons[0];
            if(canAffordNow(buyButton)){
                var prevLeader = switchLeaderToBuy(buyButton);
                bePoetic(label);
                buyableLog.info('Buying ' + label);
                kg.msg('9Souls: Buying ' + buttonLabel(buyButton));
                executedPlan[buyable] = 1;
                //console.debug(buyButton);
                //console.debug(buyButton.buttonContent);
                //window.setTimeout(() => {
                if(buyButton.update)
                    buyButton.update();
                buyButton.buttonContent.click();
                changeLeader(prevLeader);
                //}, 50);
                bought = true;
            }
        }
        return bought;
    }
    //#endregion

    //#region Jobs
    /*
    To stop kittens from starving sometimes we need to ensure a supply of farmers.
    Make sure a minimum number of kittens can farm if we project that nip will fall below our reserve threshold.
    */

    function reserveFarmers(){
        var farmerJob = kg.village.getJob('farmer');
        if(!farmerJob.unlocked)
            return 0; // Can't reserver a farmer if it's not unlocked.
        var nipRes = kg.resPool.get('catnip');
        var projectedNip = projectResourceAmount(nipRes);
        var desiredEmergencyStash = reservedNipAmount();
        var desiredAdditionalNip = desiredEmergencyStash - projectedNip;
        if(desiredAdditionalNip <= 0)
            return 0; // No extra nip needed.
        var nipPerFarmer = resoucePerTick(nipRes, 1, farmerJob);
        var desiredAdditionalNipPerTick = desiredAdditionalNip / (planHorizonSeconds() * kg.ticksPerSecond);
        var desiredReservedFarmers = desiredAdditionalNipPerTick / nipPerFarmer;
        var reservedFarmers = Math.min(kg.resPool.get('kittens').value, Math.ceil(desiredReservedFarmers));
        // jobLog.info("Projected 'nip %i, desired stash %i, additional extra nip per tick %f, farmer increment %f, desiredReservedFarmers %i",
        //     projectedNip,
        //     desiredEmergencyStash,
        //     desiredAdditionalNipPerTick,
        //     nipPerFarmer,
        //     reservedFarmers
        //     );
        return reservedFarmers;
    }

    function getJobAssignments() {
        if(!kg.villageTab.visible)
            return []
        return kg.village.jobs.filter(j => j.unlocked);
    }

    function variableFromJobAssignment(j) {
        var jv = {
            name: "Job|" + buttonId(j),
            kittens: 1
        };
        for(var mod in j.modifiers){
            var jobProduction = resoucePerTick(kg.resPool.resourceMap[mod], 1, j);
            jv[mod] = -1 * jobProduction * planHorizonSeconds() * kg.ticksPerSecond
        }
        // Little jack to incentivise unlocking workshop
        if(j.name == "miner" && !kg.bld.get("workshop").unlocked){
            jv.utility = 1;
        }
        else if (j.name == "priest"){
            if(!kg.religionTab.visible){
                // Yeah - we should unlock that ;-)
                jv.utility = 1;
            }
        }
        return jv;
    }

    function variableForFestival(){
        if(!kg.science.get("drama").researched){
            return null;
        }
        if(kg.calendar.festivalDays > (100 - kg.calendar.day)){
            return null;
        }
        return {
            name: "Festival",
            manpower: 1500,
            culture: 5000,
            parchment: 2500,
            utility: happinessUtility * 3,
            festivalCap: 1
        };
    }

    function executeFestival(){
        var numPlanned = Math.floor(plan.Festival || 0);
        if(!numPlanned){
            return;
        }
        var numPerformed = (executedPlan.Festival || 0);
        if(numPerformed > 0){
            return;
        }
        var doFest = kg.villageTab.festivalBtn;
        if(canAffordNow(doFest)){
            bePoetic("festival");
            execLog.log("P A R T Y Wooop Woop!");
            doFest.buttonContent.click();
            executedPlan.Festival = 1;
        }
    }

    function jobResourcesMaxed(job){
        for(var modifier in job.modifiers){
            var modifiedResource = kg.resPool.get(modifier);
            if(modifiedResource.value < modifiedResource.maxValue)
                return false;
        }
        return true;
    }

    function normaliseObject(probabilities){
        var total = 0;
        var nonZeroCount = 0;
        var totalCount = 0;
        for(var job in probabilities){
            totalCount++;
            probabilities[job] = Math.max(probabilities[job], 0);
            if(probabilities[job]){
                nonZeroCount++;
            }
            total += probabilities[job];
        }
        if(total == 0){
            if(nonZeroCount == 0){
                for(var job in probabilities){
                    probabilities[job] = 1 / totalCount;
                }
            } else {
                for(var job in probabilities){
                    probabilities[job] = probabilities[job] / nonZeroCount;
                }
            }
        } else {
            for(var job in probabilities){
                probabilities[job] = probabilities[job] / total;
            }
        }
        return probabilities;
    }

    function normalizeAssignments(){
        var planned = {}
        var assignments = {}
        var invalidJobs = [];
        var partials = {}
        var wastedKittens = 0;
        var partialKittens = 0;

        jobLog.log("getJobAssignments start");
        const jobs = getJobAssignments();
        jobLog.log("analyse start", jobs);
        jobLog.log("planned: ", planned);
        jobLog.log("assignments: ", assignments);
        jobLog.log("invalidJobs: ", invalidJobs);
        jobLog.log("partials: ", partials);
        // remove kittens from jobs
        for(var j of jobs){
            var numPlanned = plan["Job|" + buttonId(j)] || 0;
            if(j.name == "farmer")
                numPlanned += reservedFarmers;
            planned[j.name] = numPlanned;
            var intPlanned = Math.floor(numPlanned);
            var partial = numPlanned - intPlanned;
            partialKittens += partial;
            // Remove assignments from maxxed out jobs.
            if(jobResourcesMaxed(j)){
                jobLog.log("%s: Triggered waste detection. %i kittens doing job will be reallocated.", j.name, numPlanned);
                wastedKittens += intPlanned;
                assignments[j.name] = 0;
                partials[j.name] = 0;
                invalidJobs.push(j.name)
            } else {
                jobLog.log("%s: Not a waste actually, intPlanned %i, partial %f", j.name, intPlanned, partial);
                assignments[j.name] = intPlanned;
                partials[j.name] = partial;
            }
        }
        jobLog.log("analyse complete");
        jobLog.log("planned: ", planned);
        jobLog.log("assignments: ", assignments);
        jobLog.log("invalidJobs: ", invalidJobs);
        jobLog.log("partials: ", partials);

        // Reassign wasted based on existing ratios...
        if(wastedKittens){
            const resassignProbs = {};
            for(var jobName in assignments){
                resassignProbs[jobName] = invalidJobs.find(ij => jobName == ij) ? 0 : planned[jobName];
            }
            normaliseObject(resassignProbs);
            jobLog.log("Reassigning %f wasted kittens, totalProb %f", wastedKittens, Object.values(resassignProbs).reduce((prev, curr) => prev + curr).toFixed(4), resassignProbs);
            for(var kIdx = 0; kIdx < wastedKittens; kIdx++){
                var rj = Math.random();
                var cumProb = 0;
                for(var jobName in resassignProbs){
                    cumProb += resassignProbs[jobName];
                    if(rj < cumProb){
                        jobLog.log("Assigning wasted kitten %i to %s (random %f, cumProb %f)", kIdx, jobName, rj.toFixed(2), cumProb.toFixed(2));
                        assignments[jobName] = assignments[jobName] + 1;
                        break;
                    }
                }
            }
            jobLog.log("waste reassignment complete", assignments);
        }

        // Reassign partials
        if(partialKittens){
            partialKittens = Math.round(partialKittens);
            var resassignProbs = {};
            for(var jobName in assignments){
                resassignProbs[jobName] = invalidJobs.find(ij => jobName == ij) ? 0 : partials[jobName];
            }
            normaliseObject(resassignProbs);
            jobLog.log("Reassigning %f partial kittens, totalProb %f", partialKittens, Object.values(resassignProbs).reduce((prev, curr) => prev + curr).toFixed(4), resassignProbs);
            for(var kIdx = 1; kIdx < partialKittens + 0.1; kIdx++){
                var rj = Math.random();
                var cumProb = 0;
                for(var jobName in resassignProbs){
                    cumProb += resassignProbs[jobName];
                    if(rj < cumProb){
                        jobLog.log("Assigning partial kitten %i to %s (random %f, cumProb %f)", kIdx, jobName, rj.toFixed(2), cumProb.toFixed(2));
                        assignments[jobName] = assignments[jobName] + 1;
                        break;
                    }
                }
            }
            jobLog.log("partials reassignment complete", assignments);
        }

        var totalAssigned = 0;
        for(var a in assignments){
            totalAssigned += assignments[a];
        }
        if(totalAssigned != kg.resPool.get("kittens").value)
            jobLog.warn("assigned %i kittens (should have been %i)", totalAssigned, kg.resPool.get("kittens").value);

        jobLog.log("normalise complete", assignments);
        return assignments;
    }

    var reassignments = 0;
    function assignJobs(){
        var assignments = normalizeAssignments();
        //jobLog.log(jobNumbers)
        for(var jobName in assignments) {
            var numPlanned = assignments[jobName];
            var j = kg.village.getJob(jobName)
            //jobLog.log("Planned to assign ", numPlanned, " for job ", j.name, " currently job has ", j.value, " kittens assigned")
            if(j.value > numPlanned){
                var numToRemove = j.value - numPlanned;
                // A reassignment is moving a kitten from one job to another.
                reassignments += numToRemove;
                jobLog.log("Need to remove %i kittens from job %s (assigned %i, planned %i)", numToRemove, jobName, j.value, numPlanned);
                var jobBtn = kg.villageTab.buttons.find(b => b.opts.job == j.name);
                if(numPlanned < 1){
                    //jobLog.debug("Removing all kittens from job ", j.name);
                    jobBtn.unassignLinks.unassignAll.link.click();
                    continue;
                }
                while(numToRemove > 0){
                    if(numToRemove >= 25){
                        //jobLog.debug("Removing 25 kittens from job ", j.name);
                        jobBtn.unassignLinks.unassign25.link.click();
                        numToRemove -= 25;
                    } else if (numToRemove >= 5) {
                        //jobLog.debug("Removing 5 kittens from job ", j.name);
                        jobBtn.unassignLinks.unassign5.link.click();
                        numToRemove -= 5;
                    } else {
                        //jobLog.debug("Removing kitten from job ", j.name);
                        jobBtn.unassignLinks.unassign.link.click();
                        numToRemove -= 1;
                    }
                }
            }
        }
        // assign kittens to jobs
        for(var jobName in assignments) {
            var numPlanned = assignments[jobName];
            var j = kg.village.getJob(jobName)
            if(j.value < numPlanned){
                var jobBtn = kg.villageTab.buttons.find(b => b.opts.job == j.name);
                var numToAdd = numPlanned - j.value;
                jobLog.log("Need to add %i kittens to job %s (assigned %i, planned %i)", numToAdd, jobName, j.value, numPlanned);
                if(numToAdd == kg.village.getFreeKittens()){
                    //jobLog.debug("Adding all free kittens to job ", j.name);
                    jobBtn.assignLinks.assignall.link.click();
                    break;
                }
                while(numToAdd > 0){
                    if(numToAdd >= 25){
                        jobLog.log("Adding 25 kittens to job ", j.name);
                        jobBtn.assignLinks.assign25.link.click();
                        numToAdd -= 25;
                    } else if (numToAdd >= 5) {
                        jobLog.log("Adding 5 kittens to job ", j.name);
                        jobBtn.assignLinks.assign5.link.click();
                        numToAdd -= 5;
                    } else {
                        jobLog.log("Adding kitten to job ", j.name);
                        jobBtn.assignLinks.assign.link.click();
                        numToAdd -= 1;
                    }
                }
            }
        }
        for(var jobName in assignments) {
            if(assignments[jobName])
                executedPlan["Job|" + jobName] = assignments[jobName];
        }
        jobLog.log("reassignments since optimise ", reassignments);
        if(kg.villageTab.optimizeJobsBtn && kg.villageTab.optimizeJobsBtn.model.visible){
            if(reassignments > reassignmentsBeforeOptimise * kg.village.getKittens()){
                jobLog.log("optimise triggered %i > %f (%f * %i)", reassignments, (reassignmentsBeforeOptimise * kg.village.getKittens()).toFixed(1), reassignmentsBeforeOptimise, kg.village.getKittens());
                reassignments = 0;
                kg.villageTab.optimizeJobsBtn.buttonContent.click();
            }
        }
    }

    //#endregion

    //#region Trades
    function getTradeableRaces() {
        return kg.diplomacy.races.filter(r => r.unlocked);
    }

    function expectedResourceGain(tradeRace, sellResource){
        if(tradeRace.name == "zebras" && sellResource == "titanium"){
            //-------------- 15% + 0.35% chance per ship to get titanium ---------------
            var shipAmount = kg.resPool.get("ship").value;
            var zebraRelationModifierTitanium = kg.getEffect("zebraRelationModifier") * kg.bld.getBuildingExt("tradepost").meta.effects["tradeRatio"];
            return (1.5 + shipAmount * 0.03) * (1 + zebraRelationModifierTitanium) * ((0.15 + shipAmount * 0.0035) / 2);
        }
        var bonusForLeaderSwitch = tradeBonusForLeaderSwitch();
        var standingRatio = kg.getEffect("standingRatio") + kg.diplomacy.calculateStandingFromPolicies(tradeRace.name, kg);
        var failureChance = tradeRace.standing < 0 ? -(tradeRace.standing + standingRatio) / 2 : 0;
        var bonusTradeChance = tradeRace.standing > 0 ? tradeRace.standing + standingRatio / 2 : 0;
        var tradeRatio = 1 + bonusForLeaderSwitch + kg.diplomacy.getTradeRatio() + kg.diplomacy.calculateTradeBonusFromPolicies(tradeRace.name, kg) + kg.challenges.getChallenge("pacifism").getTradeBonusEffect(kg);
        var raceRatio = 1 + tradeRace.energy * 0.02;
        var currentSeason = kg.calendar.getCurSeason().name;
        var embassyEffect = kg.ironWill ? 0.0025 : 0.01;

        if (!kg.diplomacy.isValidTrade(sellResource, tradeRace)) {
            return 0;
        }
        var tradeChance = sellResource.chance *
            (1 + (
                tradeRace.embassyPrices ?
                kg.getLimitedDR(tradeRace.embassyLevel * embassyEffect, 0.75) :
                0)
            );
        var resourceSeasonTradeRatio = 1 + (sellResource.seasons ? sellResource.seasons[currentSeason] : 0);
        expected =
            // Basic amount specified
            sellResource.value
            // Trades for hostile races may fail completely
            * (1 - failureChance)
            // Trades with friendly races sometimes give you 25% extra
            * (1 + (0.25 * bonusTradeChance))
            // Rare resources only have some % chance to drop
            * tradeChance
            // Tradepost etc.
            * tradeRatio
            // Leviathans I think - haven't got that far yet.
            * raceRatio
            // Seasonality of resources
            * resourceSeasonTradeRatio;
        return expected;
    }

    function variableFromTrade(tradeRace, outOfReach) {
        tv = {
            name: "Trade|" + buttonId(tradeRace),
            manpower: kg.diplomacy.getManpowerCost(),
            gold: kg.diplomacy.getGoldCost(),
            blueprint: -0.1
        };
        for(res of tradeRace.buys){
            tv[res.name] = res.val;
        }

        var tradeUtility = 0;
        for(const sellResource of tradeRace.sells){
            //console.debug(res, tradeRace, res.minLevel, tradeRace.embassyLevel)
            // Mostly cribbed from diplomacy.tradeImpl
            var expected = expectedResourceGain(tradeRace, sellResource);
            if(!expected)
                continue;
            //console.debug(sellResource.value, failureChance, bonusTradeChance, tradeChance, tradeRatio, raceRatio, resourceSeasonTradeRatio)
            //console.debug(expected)

            /*We can't actually store more than our Max amount. I'm looking at you Sharks...
    \.          |\
    \`.___---~~  ~~~--_
    //~~----___  (_o_-~
    '           |/'
            */
            var sellResPoolRes = kg.resPool.get(sellResource.name);
            reserved = sellResPoolRes.name == "catnip" ? reservedNipAmount() : 0;
            if(sellResPoolRes.maxValue){
                expected = Math.min(expected, sellResPoolRes.maxValue - reserved);
            }
            // Manuscript max culture bonus may influence trade utility
            if (sellResource.name == "manuscript") {
                tradeUtility += manuscriptUtility(outOfReach) * expected;;
            }
            // compendium max science bonus may influence trade utility
            else if (sellResource.name == "compedium") {
                tradeUtility += compendiumScienceUtility(outOfReach) * expected;
            }

            tv[sellResource.name] = -expected
        }
        var embassyEffect = kg.ironWill ? 0.0025 : 0.01;
        tv.spice = -0.35 * (1 + (tradeRace.embassyPrices ?  tradeRace.embassyLevel * embassyEffect : 0))
        if (tradeRace.name == "zebras") {
            tv.titanium = -expectedResourceGain(tradeRace, "titanium");
        }

        // Trades can generate Spice, which is a luxury. Grant some utility for that if we are below some threshold.
        var spiceRes = kg.resPool.get("spice");
        var spiceCons = resoucePerTick(spiceRes);
        if(projectResourceAmount(spiceRes) < -1 * spiceCons * kg.ticksPerSecond * planHorizonSeconds()){
            tradeUtility += happinessUtility;
        }
        if(tradeUtility){
            tv.utility = tradeUtility;
        }
        return tv;
    }

    // Maximum number of trades to perform now such that we don't go over our resource caps.
    function maxTradesBatch(race){
        var maxTradesToCap = Infinity;
        for(sellResource of race.sells){
            //you must be this tall to trade this rare resource
            if (!kg.diplomacy.isValidTrade(sellResource, race)) {
                continue;
            }
            var res = kg.resPool.get(sellResource.name);
            var cap = res.maxValue
            if(!cap) {
                continue;
            }
            var capLessCurrent = cap - res.value;
            var maxTradeAmt = expectedResourceGain(race, sellResource) * (1 + sellResource.width);
            var tradesBeforeMax = capLessCurrent / maxTradeAmt;
            maxTradesToCap = Math.min(maxTradesToCap, tradesBeforeMax);
        }
        if(race.name == "zebras"){
            // fuck you zebras
            // Multiplier is chosen out of thin air because I'm lazy.
            // Also hee hee titMaxGain.
            var titMaxGain = expectedResourceGain(race, "titanium") * 1.5;
            var res = kg.resPool.get("titanium");
            var titCapLessCurrent = res.maxValue - res.value;
            var titTradesBeforeMax = titCapLessCurrent / titMaxGain;
            maxTradesToCap = Math.min(maxTradesToCap, titTradesBeforeMax);
        }
        return maxTradesToCap;
    }

    function executeTrades(){
        var mpCost = kg.diplomacy.getManpowerCost();
        var goldCost = kg.diplomacy.getGoldCost();
        var basePrices = [{
            name: "gold",
            val: goldCost
        }, {
            name: "manpower",
            val: mpCost
        }];

        var plannedTrades = Object.keys(plan).filter(planItem => planItem.startsWith("Trade"));
        shuffle(plannedTrades);
        for(tradeable of plannedTrades) {
            const desiredTrades = (plan[tradeable] || 0);
            const executedTrades = (executedPlan[tradeable] || 0);
            const desiredRemainingTrades = desiredTrades - executedTrades;
            const raceName = tradeable.slice(6);
            if(desiredRemainingTrades < 1){
                tradeLog.log("No more trades desired with %s (planned %f executed %i)", raceName, desiredTrades.toFixed(1), executedTrades);
                continue;
            }
            var race = kg.diplomacy.get(raceName);
            //const race = kg.diplomacy.get(raceName);
            //var tradeBtn = kg.diplomacyTab.racePanels.find(rp => rp.race.name == raceName).tradeBtn
            //tradeLog.log(tradeBtn);
            var tradesPossibleNow = Math.floor(canAffordHowManyNow({
                model: {
                    prices: [].concat(basePrices, race.buys)
                }
            }));
            if(tradesPossibleNow < 1){
                tradeLog.log("No trades possible with %s right now", raceName);
                continue;
            }
            var tradesToPerform = Math.floor(Math.min(desiredRemainingTrades, tradesPossibleNow));
            if(tradesToPerform <= 0){
                tradeLog.log("I don't even know how I'd end up in this branch!?");
                continue;
            }
            if(!civilServiceNotResearched()){
                var prevLeader = doLeaderChangeTrait("merchant");
                tradeLog.log("Changed leader to trade previous ", prevLeader, " now ", kg.village.leader);
            }

            var maxTra = maxTradesBatch(race);
            tradesToPerform = Math.floor(Math.max(Math.min(tradesToPerform, maxTra), 1));
            bePoetic(raceName);
            kg.diplomacy.tradeMultiple(race, tradesToPerform);

            executedPlan[tradeable] = executedTrades + tradesToPerform;
        }
    }

    //#endregion

    //#region Crafts

    function getCrafts(){
        if(kg.workshopTab.visible)
            return kg.workshopTab.craftBtns.filter(b => b.model.visible && isFeasible(b));
        else
            return [kg.bldTab.children.find(btn => btn.model.name == "Refine catnip")];
    }

    function variableFromCraft(c, outOfReach){
        craft = c.craftName || 'wood'
        cv = {
            name: "Craft|" + craft
        };
        var craftAmt = (1 + kg.getResCraftRatio(craft) + craftBonusForLeaderSwitch(craft) - currentLeaderCraftBonus(craft))
        craftLog.log(craft + " craftAmt " + craftAmt)
        cv[craft] = -craftAmt;
        var craftPrices = kg.workshop.getCraftPrice(c.model);
        for(price of craftPrices){
            cv[price.name] = price.val;
        }
        if(craft == "wood" && kg.bld.buildingsData.find(b => b.name == 'hut').val < 1){
            // We don't even have a hut yet, how quaint, we should do a little refining
            cv.utility = 1
            craftLog.log("wood craft utility: " + cv.utility)
        }
        // Mild bonus for unlock ziggurat
        else if(craft == "megalith" || craft == "scaffold"){
            if(!kg.bld.get("ziggurat").unlocked && kg.resPool.get(craft).value == 0){
                cv.utility = 0.4;
                craftLog.log(craft + " craft utility: " + cv.utility)
            }
        }
        // Ships are good, up to a point ;-)
        else if(craft == "ship"){
            const maxShips = 5000;
            const fractionofShipsPerUtility = 0.15;
            const builtAlready = kg.resPool.get("ship").value;
            if(builtAlready == 0) {
                cv.utility = 5;
                craftLog.log("Initial ship craft utility: " + cv.utility)
            } else if(builtAlready < maxShips){
                const shipsPerUtility = builtAlready * fractionofShipsPerUtility;
                const utilityPerCraft = craftAmt / shipsPerUtility;
                cv.utility = utilityPerCraft;
                craftLog.log("ship craft utility: " + cv.utility)
            }
            const cargoShips = kg.workshop.get("cargoShips");
            if(cargoShips.researched){
                // Buildings.js line ~850
                //100% to 225% with slow falldown on the 75%
                var limit = 2.25 + kg.getEffect("shipLimit") * kg.bld.get("reactor").on;
                var ratioNow = 1 + kg.getLimitedDR(cargoShips.effects["harborRatio"] * builtAlready, limit);
                var ratioAfterCraft = 1 + kg.getLimitedDR(cargoShips.effects["harborRatio"] * (builtAlready + craftAmt), limit);
                var ratioChange = ratioAfterCraft - ratioNow;

                var shipStorageUtility = utilityForSorageCap("ship", outOfReach, {
                    catnipMax: (2500 * ratioChange), woodMax: (700 * ratioChange), mineralsMax: (950 * ratioChange), coalMax: (100 * ratioChange), ironMax: (150 * ratioChange), titaniumMax: (50 * ratioChange), goldMax: (25 * ratioChange)
                }
                );
                cv.utility += shipStorageUtility;
                craftLog.log("ship utility for storage: " + shipStorageUtility + " total ship craft utility" + cv.utility )
            }
        } else if (craft == "tanker"){
            var tankerUtility = utilityForSorageCap("tanker", outOfReach, {oilMax: 500 * craftAmt});
            craftLog.log("tanker utility for storage: " + tankerUtility)
            cv.utility = tankerUtility;
        }
        // Manuscript max culture bonus (and may incentivize early temple)
        else if (craft == "manuscript") {
            cv.utility = manuscriptUtility(outOfReach) * craftAmt;
            craftLog.log("manuscript craft utility: " + cv.utility)
            if(!kg.resPool.get(craft).value){
                cv.utility += 1
                craftLog.log("Bumping manuscript for initial manuscript: " + cv.utility)
            }
        }
        // compendium max science bonus minus penalty for losing manuscripts
        // nice typo in the craft name BTW
        else if (craft == "compedium") {
            cv.utility = compendiumUtility(outOfReach, craftPrices, craftAmt);
            craftLog.log("compendium craft utility: " + cv.utility)
        }
        // blueprints lose compendia :-(
        else if (craft == "blueprint") {
            cv.utility = blueprintUtility(outOfReach, craftPrices);
            craftLog.log("blueprint craft utility: " + cv.utility)
        }
        return cv;
    }

    function blueprintUtility(outOfReach, craftPrices){
        return -1 * compendiumScienceUtility(outOfReach) * craftPrices.find(cp => cp.name == "compedium").val;
    }

    function compendiumScienceUtility(outOfReach){
        // Workshop.js ~line 2592
        var scienceMaxCap = kg.bld.getEffect("scienceMax");
        scienceMaxCap += kg.getEffect("pyramidSpaceCompendiumRatio") * kg.space.getEffect("scienceMax"); //lets treat trasnfered science max from space same way
        if (kg.ironWill) {
            scienceMaxCap *= 10;
        }
        if (kg.prestige.getPerk("codexLeviathanianus").researched) {
            var blackLibrary = kg.religion.getTU("blackLibrary");
            var ttBoostRatio = 1 + blackLibrary.val * (blackLibrary.effects["compendiaTTBoostRatio"] + kg.getEffect("blackLibraryBonus"));
            scienceMaxCap *= 1 + 0.05 * ttBoostRatio * kg.religion.transcendenceTier;
        }
        scienceMaxCap += kg.bld.getEffect("scienceMaxCompendia");
        var compendiaScienceMax = Math.floor(kg.resPool.get("compedium").value * 10);

        // If we haven't capped max science bonus from compendia then we can incentivise making them based on increasing science storage.
        return compendiaScienceMax < scienceMaxCap ? utilityForSorageCap("compendia", outOfReach, {scienceMax: 10}) : 0;
    }

    function compendiumUtility(outOfReach, craftPrices, craftAmt){
        var scienceUtility = compendiumScienceUtility(outOfReach);
        var manuscriptUtilityLost = manuscriptUtility(outOfReach) * craftPrices.find(cp => cp.name == "manuscript").val;
        craftLog.log("scienceUtility %f, manuscriptUtilityLost %f", scienceUtility.toFixed(4), manuscriptUtilityLost.toFixed(4));
        return (scienceUtility * craftAmt) - manuscriptUtilityLost;
    }

    function manuscriptUtility(outOfReach){
            // Workshop.js ~line 2611
            var cultureBonusRaw = Math.floor(kg.resPool.get("manuscript").value);
            var additionalMaxCultureFromManuscript = kg.getUnlimitedDR(cultureBonusRaw + 1, 0.01) - kg.getUnlimitedDR(cultureBonusRaw, 0.01);
            additionalMaxCultureFromManuscript *= 1 + kg.getEffect("cultureFromManuscripts");
            var utility = utilityForSorageCap("manuscript", outOfReach, {cultureMax: additionalMaxCultureFromManuscript});
            craftLog.log("additionalMaxCultureFromManuscript %f, utility %f", additionalMaxCultureFromManuscript.toFixed(1), utility.toFixed(4));
            return utility;
    }

    // function executeCraftsFrom(resources){
    //     var validCrafts = game.workshop.crafts.filter(c =>
    //         c.prices.every(p =>
    //             resources.indexOf(p.name) >= 0));
    //     validCrafts.forEach(c => {

    //     });
    //     return validCrafts;
    // }

    function executeCrafts(){
        const craftButtons = getCrafts();
        for(craftable in plan) {
            if(!craftable.startsWith("Craft")){
                continue;
            }
            const alreadyDone = executedPlan[craftable] || 0;
            const totalNumDesiredRemaining = (plan[craftable] || 0) - alreadyDone;
            var numDesiredRemaining = Math.floor(totalNumDesiredRemaining);
            if((totalNumDesiredRemaining - numDesiredRemaining) > buyThreshold)
                numDesiredRemaining += 1;
            if(numDesiredRemaining <= 0)
                continue;
            const craftName = craftable.slice(6);
            craftLog.log(craftable, craftName, alreadyDone, numDesiredRemaining);
            const btn = craftButtons.find(btn => (btn.opts.craft || "wood") == craftName);
            if(!btn){
                craftLog.warn("Couldn't locate craft button for ", craftName, ". WTF?");
                continue;
            }
            const numCanAfford = canAffordHowManyNow(btn);
            if(numCanAfford < 1)
                continue;
            const numToActuallyCraft = Math.floor(Math.min(numCanAfford, numDesiredRemaining))
            if(numToActuallyCraft < 1)
                continue;

            switchLeaderToCraft(craftName);
            craftLog.log("Crafting %i %s (%i/%f)", numToActuallyCraft, craftName, alreadyDone + numToActuallyCraft, plan[craftable].toFixed(2))
            bePoetic(craftName);
            executedPlan[craftable] = alreadyDone + numToActuallyCraft;
            kg.workshop.craft(craftName, numToActuallyCraft)
        }
    }

    //#endregion

    //#region Explore

    function canUnlockRace(){
        // See diplomacy.js unlockRandomRace, ~ln 270
        // Is any of the "low requirement" 3 still locked
        if(kg.diplomacy.races.slice(0, 3).find(r => !r.unlocked))
            return true;
        var nagas = kg.diplomacy.get("nagas");
        if (!nagas.unlocked && kg.resPool.get("culture").value >= 1500){
            return true;
        }
        var zebras = kg.diplomacy.get("zebras");
        if (!zebras.unlocked && kg.resPool.get("ship").value >= 1){
            return true;
        }
        var spiders = kg.diplomacy.get("spiders");
        if (!spiders.unlocked && kg.resPool.get("ship").value >= 100 && kg.resPool.get("science").maxValue > 125000){
            return true;
        }
        var dragons = kg.diplomacy.get("dragons");
        if (!dragons.unlocked && kg.science.get("nuclearFission").researched){
            return true;
        }
        return false;
    }

    function variableFromExplore() {
        kg.diplomacyTab.render();
        if(!kg.diplomacyTab.visible)
            return null;
        if(!isFeasible(kg.diplomacyTab.exploreBtn))
            return null; // Get some more kittens you pleb.
        if(!canUnlockRace())
            return null;
        return {
            name: "Explore",
            manpower: 1000,
            utility: 10
        };
    }

    function executeExplore() {
        if(!kg.diplomacyTab.visible)
            return null;
        desiredExplore = (plan["Explore"] || 0);
        if(desiredExplore < 1)
            return;

        var btn = kg.diplomacyTab.exploreBtn
        if(canAffordNow(kg.diplomacyTab.exploreBtn)){

            bePoetic("explore");
            kg.msg('9Souls: To seek out new life and new civilizations...');
            btn.buttonContent.click();
            executedPlan.Explore = 1;
            jobLog.log("Replanning (explored)");
            planNow();
        }
    }

    //#endregion

    //#region Hunts

    function variableFromHunt(){
        if(!kg.villageTab.visible || !kg.villageTab.huntBtn.model.visible)
            return [];
        hunterRatio = kg.getEffect("hunterRatio") + kg.village.getEffectLeader("manager", 0);
        ivoryProb = (0.45 + 0.02 * hunterRatio) / 2;
        averageIvory = ivoryProb * (50 + (40 * hunterRatio));
        averageFurs = (80 + (65 * hunterRatio)) / 2;

        // There is some utility to having a few luxury resources floating about (about a season's worth buffer?).
        furRes = kg.resPool.get('furs');
        ivoryRes = kg.resPool.get('ivory');
        furCons = resoucePerTick(furRes, 0, null);
        ivoryCons = resoucePerTick(ivoryRes, 0, null);

        utilityForLux = 0
        var furDesiredToBuffer = -1 * furCons * kg.ticksPerSecond * planHorizonSeconds() - projectResourceAmount(furRes);
        var huntsToFillFurBuffer = furDesiredToBuffer / averageFurs;
        if(furDesiredToBuffer > 0){
            utilityForLux += happinessUtility;
        }
        var ivoryDesiredToBuffer = -1 * ivoryCons * kg.ticksPerSecond * planHorizonSeconds() - projectResourceAmount(ivoryRes);
        var huntsToFillIvoryBuffer = ivoryDesiredToBuffer / averageIvory;
        if(ivoryDesiredToBuffer > 0){
            utilityForLux += happinessUtility;
        }
        // Sooo sparkly.
        unicornResource = kg.resPool.get('unicorns');
        if(unicornResource.value == 0){
            utilityForLux += 0.1;
        }

        var huntVar = {
            name: "Hunt|ForResources",
            manpower: 100,
            unicorns: -0.05,
            ivory: -averageIvory,
            furs: -averageFurs,
        };

        var huntVars = [huntVar];
        if(utilityForLux > 0){
            // craftLog.log("Hunt for luxury utility as follows, $s", {
            //     furDesiredToBuffer: furDesiredToBuffer,
            //     huntsToFillFurBuffer: huntsToFillFurBuffer,
            //     ivoryDesiredToBuffer: ivoryDesiredToBuffer,
            //     huntsToFillIvoryBuffer: huntsToFillIvoryBuffer,
            //     unicorns: unicornResource.value > 0,
            //     utilityForLux: utilityForLux
            // });

            huntVars.push({
                name: "Hunt|ForLuxury",
                manpower: 100,
                unicorns: -0.05,
                ivory: -averageIvory,
                furs: -averageFurs,
                huntForLuxury: 1,
                huntForLuxuryMax: Math.ceil(Math.max(huntsToFillFurBuffer, huntsToFillIvoryBuffer, 1)),
                utility: utilityForLux
            });
        }
        return huntVars;
    }

    function executeHunts() {
        if(!kg.villageTab.visible || !kg.villageTab.huntBtn.model.visible)
            return;
        desiredHunts = Math.ceil((plan["Hunt|ForResources"] || 0) + (plan["Hunt|ForLuxury"] || 0));
        executedHunts = executedPlan["Hunt"] || 0;
        desiredRemainingHunts = desiredHunts - executedHunts;
        if(desiredRemainingHunts < 1)
            return;
        possibleHuntsNow = Math.floor(kg.resPool.get("manpower").value / 100);
        if(possibleHuntsNow < 1)
            return;
        huntsToPerform = Math.min(desiredRemainingHunts, possibleHuntsNow)
        craftLog.log("Hunting ", huntsToPerform, huntsToPerform == possibleHuntsNow ? "  (as many as possible)" : ""," times (", executedHunts + huntsToPerform, "/", desiredHunts ,")")

        bePoetic("hunt");
        if(huntsToPerform == possibleHuntsNow){
            kg.village.huntAll()
        } else {
            for(i = 0; i < huntsToPerform; i++){
                kg.villageTab.huntBtn.buttonContent.click()
            }
        }
        executeCrafts();
        executedPlan["Hunt"] = executedHunts + huntsToPerform;
    }

    //#endregion

    //#region Incrementable Building

    function getToggleableBuildings(){
        return kg.bld.buildingsData.filter(function(b){return b.val > 0 && b.togglableOnOff; });
    }

    function variableFromToggleableBuilding(bld){
        bldId = buttonId(bld)
        bv = {
            name: "ToggleBuilding|" + bldId
        };
        bv[bldId] = 1;
        var effects = bld.effectsCalculated || bld.effects;
        if(bldId == "steamworks"){
            bv.energy = -1 * effects.energyProduction * bld.val;

            const magneto = kg.bld.get("magneto");
            const maxMagnetoBoost = magneto.val * magneto.effects.magnetoRatio;
            const additionalBoostRatio = effects.magnetoBoostRatio * bld.val;
            const additionalBoostRatioEffect = maxMagnetoBoost * effects.magnetoBoostRatio * bld.val;
            bv.utility = additionalBoostRatioEffect * globalProductionUtility * 100;
            buyableLog.log({
                magnetos: magneto.val,
                magnetoRatio: magneto.effects.magnetoRatio,
                maxMagnetoBoost: maxMagnetoBoost,
                magnetoBoostRatio: effects.magnetoBoostRatio,
                numBlds: bld.val,
                additionalBoostRatio: additionalBoostRatio,
                additionalBoostRatioEffect: additionalBoostRatioEffect,
                utility: bv.utility
            });

            var coalRes = kg.resPool.get("coal");
            var coalNoSteam = resoucePerTick(coalRes, 0);
            var coalWithSteam = resoucePerTick(coalRes, 3, bld);
            var coalPerTickDiff = coalNoSteam - coalWithSteam;
            bv.coal = coalPerTickDiff * kg.ticksPerSecond * planHorizonSeconds();

            if(effects.manuscriptPerTickProd){
                bv.manuscript = -1 * effects.manuscriptPerTickProd * kg.ticksPerSecond * planHorizonSeconds() * bld.val;
            }
        }
        return bv;
    }

    function executeToggleBuildings(){
        for(var bld of getToggleableBuildings()){
            bldId = buttonId(bld)
            const probOn = (plan["ToggleBuilding|" + bldId] || 0);
            const wantedOn = Math.random() < probOn ? true : false;
            const currentlyOn = bld.on == bld.val;
            if(wantedOn != currentlyOn){
                buyableLog.log("%s desiredOn %s currentlyOn %s", bldId, wantedOn, currentlyOn);
                var btn = kg.bldTab.children.find(btn => buttonId(btn) == bldId);
                btn.toggle.link.click();
            }
        }
    }

    function getIncrementableBuildings(){
        return kg.bld.buildingsData.filter(b => b.val > 0 && b.togglable);
    }

    function variableFromIncrementableBuilding(bld){
        bldId = buttonId(bld)
        bv = {
            name: "IncrementBuilding|" + bldId,
            // Default to on and producing but easily subvertible
            utility: 0.0001
        };
        bv[bldId] = 1;
        var effects = bld.effectsCalculated || bld.effects;

        // Smelter doesn't have correct values in effects, only effectsCalculated
        // Calciner doesn't have energyConsumption in effectsCalculated, only effects
        // Magneto doesn't have effectsCalculated at all. It's all a bit yikes.
        if(bld.effects && bld.effects.energyConsumption)
            bv.energy = bld.effects.energyConsumption;

        for(effect in effects){
            if(effect == "energyProduction"){
                bv.energy = -1 * effects[effect];
                continue;
            }
            else if(effect == "energyConsumption"){
                bv.energy = effects[effect];
                continue;
            }
            else if (effect == "craftRatio"){
                bv.utility = (bv.utility || 0) + (utilityForCraftEffectiveness * 100 * effects[effect]);
            }
            else if (effect == "magnetoRatio") {
                bv.utility = (bv.utility || 0) + (globalProductionUtility * 100 * effects[effect]);
            }
            else if (effect == "productionRatio") {
                bv.utility = (bv.utility || 0) + (globalProductionUtility * 100 * effects[effect]);
            }
            if(! (effect.endsWith('PerTickAutoprod') || effect.endsWith('PerTickCon') || effect.endsWith('PerTick') || effect.endsWith('PerTickBase') )){
                //buyableLog.log("Ignoring effect ", effect, "(not production related)");
                continue;
            }
            if(effects[effect] == 0) {
                //buyableLog.log("Ignoring effect ", effect, "(zero value)");
                continue;
            }
            var resName = effect.slice(0, effect.indexOf('PerTick'));
            var res = kg.resPool.get(resName);
            //console.log(res)
            if(!res){
                buyableLog.warn(bld, " is claiming to make a resource ", resName, " I can't find ", bld)
                continue;
            }
            resRate = resoucePerTick(res, 2, bld);
            bv[resName] = -resRate * kg.ticksPerSecond * planHorizonSeconds();
        }

        // Breweries should be off except during festivals.
        if(bldId == "brewery"){
            if(kg.calendar.festivalDays > 0){
                // Valueing happiness at ~0.2 per 10% currently.
                bv.utility = happinessUtility * 3 / 100;
            } else {
                bv.utility = -0.01;
            }
        }

        return bv;
    }

    function filterHtmlCollection(collection, filterFn){
        var elems = []
        for(item of collection){
            if(filterFn(item))
                elems.push(item);
        }
        return elems;
    }

    function findHtmlCollection(collection, filterFn){
        for(var item of collection){
            if(filterFn(item))
                return item;
        }
        return null;
    }

    function executeIncrementableBuilding(){
        for(var toggleableBld of getIncrementableBuildings()) {
            var desiredOn = plan["IncrementBuilding|" + toggleableBld.name] || 0;
            var bldBtn = kg.bldTab.children.find(btn => btn.opts.building == toggleableBld.name)
            var currentlyOn = bldBtn.model.on;
            var prob = desiredOn - Math.floor(desiredOn)
            if(Math.random() < prob)
                desiredOn = Math.ceil(desiredOn)
            else
                desiredOn = Math.floor(desiredOn)
            //buyableLog.log("%s desired on %i", toggleableBld.name, desiredOn);
            if(currentlyOn == desiredOn){
                //buyableLog.log("%s currently on %i matches desired on %i", toggleableBld.name, currentlyOn, desiredOn);
                continue;
            }

            var onLinksDiv = findHtmlCollection(bldBtn.buttonContent.children, c => c.tagName == "DIV" && findHtmlCollection(c.children, anc => anc.tagName == "A" && anc.title == "+") != null)
            var offLinksDiv = findHtmlCollection(bldBtn.buttonContent.children, c => c.tagName == "DIV" && findHtmlCollection(c.children, anc => anc.tagName == "A" && anc.title == "-") != null)
            var onMultiDiv = findHtmlCollection(onLinksDiv.children, c => c.tagName == "DIV" && c.className == "linkContent")
            var offMultiDiv = findHtmlCollection(offLinksDiv.children, c => c.tagName == "DIV" && c.className == "linkContent")
            if(desiredOn == bldBtn.model.metadata.val){
                //buyableLog.log("Firing up all ", toggleableBld.name)
                var onAllLink = findHtmlCollection(onMultiDiv.children, l => l.tagName == "A" && l.title == "+all")
                onAllLink.click();
                continue;
            }
            if(desiredOn == 0) {
                //buyableLog.log("Power down all ", toggleableBld.name)
                var offAllLink = findHtmlCollection(offMultiDiv.children, l => l.tagName == "A" && l.title == "-all")
                offAllLink.click();
                continue;
            }
            //buyableLog.log("Moderating number of ", toggleableBld.name, " to ", desiredOn, " from ", currentlyOn)
            var changeAmount = Math.abs(currentlyOn - desiredOn);
            if(currentlyOn > desiredOn){
                singleLink = findHtmlCollection(offLinksDiv.children, l => l.tagName == "A")
                twentyFiveLink = findHtmlCollection(offMultiDiv.children, l => l.tagName == "A" && l.title == "-25")
            } else {
                singleLink = findHtmlCollection(onLinksDiv.children, l => l.tagName == "A")
                twentyFiveLink = findHtmlCollection(onMultiDiv.children, l => l.tagName == "A" && l.title == "+25")
            }
            while(changeAmount > 0){
                if(changeAmount > 25) {
                    twentyFiveLink.click();
                    changeAmount -= 25;
                }
                else {
                    singleLink.click();
                    changeAmount -= 1;
                }
            }
        }
    }

    //#endregion

    //#region Simulate Production

    function copyCurrentResources(){
        return kg.resPool.resources.map(r => {return {resource: r.name, value: r.value}});
    }

    function diffResources(before, after){
        var diffObj = {};
        if(before.length != after.length){
            logger.error("Resource arrays not of equal length. Unable to diff.");
            return {};
        }
        for(var resIdx = 0; resIdx < before.length; resIdx++){
            var diff = after[resIdx].value - before[resIdx].value;
            if(diff)
                diffObj[before[resIdx].resource] = diff;
        }
        return diffObj;
    }

    function resoucePerTick(res, mode = 0, modeVariable = null) {
        simLog.log("resoucePerTick(%s, %i, %s)", res.name, mode, buttonId(modeVariable))
        var productionStack = kg.getResourcePerTickStack(res.name, false, kg.calendar.season);
        if(mode == 3 && res.name == "coal"){
            if(productionStack.find(s => s.name == "Steamworks") == null){
                productionStack.splice(8, 0, {name: "Steamworks", type: "ratio", value: modeVariable.effects.coalRatioGlobal});
            }
        }
        var resPerTick = evaluateProductionStack(productionStack, res, mode, modeVariable)
        simLog.log("resoucePerTick(%s, %i, %s) = %f", res.name, mode, buttonId(modeVariable), resPerTick.toFixed(3))
        return resPerTick;
    }

    function debugProdStack(resName, mode, modeVarName){
        var res = kg.resPool.get(resName);
        modeVar = null;
        switch(mode){
            case 1:
                modeVar = getJobAssignments().find(ja => ja.name == modeVarName);
                break;
            case 2:
            case 3:
                modeVar = kg.bld.get(modeVarName);
        }
        return debug(() => resoucePerTick(res, mode, modeVar), simLog);
    }

    /*
    mode:
    0 / undefined - Non variable production
    1 - Single villager production (modeVariable = job)
    2 - Single building production (modeVariable = building)
    3 - Steamworks  (modeVariable = Steamworks)
    */
    function evaluateProductionStack(stack, resource, mode, modeVariable){
        var prod = 0.0;
        var lastMod = null;
        var effects = modeVariable ? modeVariable.effectsCalculated || modeVariable.effects : null;

        simLog.log(stack)
        for(var resourceModifier of stack){
            simLog.log(prod, resourceModifier)
            if(resourceModifier instanceof(Array))
                prod += evaluateProductionStack(resourceModifier, resource, mode, modeVariable)
            // These are variable - we want to get production without these effects.
            else if(resourceModifier.name == '(:3) Village'){
                if(mode == 1){
                    simLog.log("Kitten: adding one villager of production", modeVariable.modifiers, modeVariable.modifiers[resource.name])
                    prod += (modeVariable.modifiers[resource.name] || 0) * kg.village.happiness
                } else {
                    simLog.log("Non-Kitten: ignoring village production")
                    continue;
                }
            }
            else if (resourceModifier.name == "Production" && lastMod == null) {
                switch(mode){
                    case 1:
                        simLog.log("Kitten: ignoring fixed production")
                        break;
                    case 0:
                    case 3:
                        simLog.log("SimpleMode: Include fixed")
                        prod += resourceModifier.value;
                        break;
                    case 2:
                        var bldFixed = effects[resource.name + "PerTickBase"] || 0;
                        simLog.log("Building: Fixed production from bld %f", bldFixed.toFixed(2))
                        prod += bldFixed;
                }
            }
            else if (resourceModifier.name == 'Conversion Production' && lastMod == null){
                if(mode == 2) {
                    var bldAutoprod = effects[resource.name + "PerTickAutoprod"] || 0;
                    simLog.log("Building: Autoprod from bld %f", bldAutoprod.toFixed(2))
                    prod += bldAutoprod;
                } else {
                    simLog.log("Non-Building: Ignoring '%s'", resourceModifier.name)
                    continue;
                }
            }
            else if(resourceModifier.name == "Without Improvement" && lastMod == null){
                if(mode == 2){
                    var withoutImp = effects[resource.name + "PerTick"] || 0;
                    simLog.log("Building: PerTick from bld %f", withoutImp.toFixed(2))
                    prod += withoutImp
                } else {
                    simLog.log("Non-Building: Ignoring '%s'", resourceModifier.name)
                    continue;
                }
            }
            else if (resourceModifier.name == 'Conversion Production' && lastMod != null){
                switch(mode){
                    case 0:
                    case 1:
                        simLog.log("Village / Fixed: Ingoring conversion")
                        break;
                    case 2:
                        var perTickProd = effects[resource.name + "PerTickProd"] || 0;
                        simLog.log("Building: Production from bld %f", perTickProd.toFixed(2));
                        prod += perTickProd;
                        break;
                    case 3:
                        var perTickProd = effects[resource.name + "PerTickProd"] || 0;
                        simLog.log("Steamworks: PerTickProd each from bld %f", perTickProd.toFixed(2))
                        prod += perTickProd * modeVariable.val;
                        break;
                }
            }
            else if (resourceModifier.name == 'Conversion Consumption'){
                if(mode == 2){
                    var consump = (effects[resource.name + "PerTickCon"] || 0);
                    simLog.log("Building: Consumption from bld %f", consump.toFixed(2))
                    prod += consump;
                } else {
                    simLog.log("Non-Building: Ignoring '%s'", resourceModifier.name)
                    continue;
                }
            }
            else if (resourceModifier.name == 'Steamworks' && mode != 3){
                simLog.log("Non-Steamworks: Ignoring '%s'", resourceModifier.name)
                continue;
            }
            // else if (resourceModifier.name == 'Magnetos'){
            //     var magRatio = 1 + kg.getEffect("magnetoRatio");
            //     if(mode == 3){
            //         var swRatio = (1 + modeVariable.effects["magnetoBoostRatio"] * modeVariable.val);
            //         magRatio *= swRatio
            //     }
            //     prod *= magRatio;
            // }
            else if (resourceModifier.type == 'fixed') {
                if(mode == 0 || mode == 3){
                    simLog.log("SimpleMode: Include fixed")
                    prod += resourceModifier.value;
                }
                else {
                    simLog.log("Non-SimpleMode: Exclude fixed")
                    continue;
                }
            }
            else if (resourceModifier.type == 'ratio'){
                simLog.log("Include ratio effect")
                prod *= 1 + resourceModifier.value;
            }
            else {
                simLog.log("Didn't know how to include calculation of ", resourceModifier, " in evaluateProductionStackNonVariable.");
            }
            lastMod = resourceModifier
        }
        return prod;
    }

    function projectResourceAmount(res) {
        var baseProduction = resoucePerTick(res, 0, null);
        var projected = res.value + (baseProduction * kg.ticksPerSecond * planHorizonSeconds());
        var timeRatioBonus = 1 + kg.getEffect("timeRatio") * 0.25;
        var chanceRatio = (kg.prestige.getPerk("chronomancy").researched ? 1.1 : 1) * timeRatioBonus;
        if(res.name == "science"){
            // Astro events.
            var eventChance = (0.0025 + kg.getEffect("starEventChance")) * chanceRatio;
            if (kg.prestige.getPerk("astromancy").researched) {
                eventChance *= 2;
            }
            // Evaluated once per day.
            var astroEventsExpected = eventChance * planHorizonSeconds() / 2;
            var celestialBonus = kg.workshop.get("celestialMechanics").researched
                ? (kg.ironWill ? 1.6 : 1.2)
                : 1;
            var sciBonus = 25 * celestialBonus * (1 + kg.getEffect("scienceRatio"));
            // starchart bonus
            sciBonus *= Math.max(1, eventChance);
            projected += astroEventsExpected * sciBonus;
        }
        if(projected < 0)
            return 0;
        if(res.maxValue)
            return Math.min(projected, res.maxValue);
        else
            return projected;
    }

    // Reserve several days of nip
    function reservedNipAmount(){
        var nipDemandRatio = 1 + kg.globalEffectsCached.catnipDemandRatio;
        var ktns = kg.resPool.resourceMap["kittens"].value ;
        return ktns * nipDemandRatio * kg.village.happiness * 4 * reservedNipDays
    }

    //#endregion

    //#region Include External Libraries
    var solver;
    function includeSolver() {
        if (typeof solver !== 'undefined') {
            console.log("solver already included");
            return;
        }
        var xhttp = new XMLHttpRequest();
        xhttp.onreadystatechange = function() {
            if (this.readyState == 4 && this.status == 200) {
            eval(xhttp.responseText);
            console.log("lp solver downloaded and executed");
            }
        };
        xhttp.open("GET", "https://unpkg.com/javascript-lp-solver@0.4.24/prod/solver.js", true);
        xhttp.send();
    }
//    includeSolver();


    var logger;
    var leaderLog;
    var faithLog;
    var execLog;
    var buyableLog;
    var jobLog;
    var craftLog;
    var simLog;
    var tradeLog;
    function makeLogger(logname) {
        var l = woodman.getLogger(logname);
        l.level = "info";
        return l;
    }

    function setupLoggers(){
        woodman.load('console');
        logger ||= makeLogger("main")
        leaderLog ||= makeLogger("main.Leader");
        faithLog ||= makeLogger("main.faith");
        execLog ||= makeLogger("main.Execution");
        buyableLog ||= makeLogger("main.buyable");
        jobLog ||= makeLogger("main.Jobs");
        craftLog ||= makeLogger("main.Craft");
        simLog ||= makeLogger("main.Simulate");
        tradeLog ||= makeLogger("main.Trade");
    }

    function includeLoglevel() {
        if (typeof woodman !== 'undefined') {
            setupLoggers();
            logger.log("woodman already included");
            return;
        }
        var xhttp = new XMLHttpRequest();
        xhttp.onreadystatechange = function() {
            if (this.readyState == 4 && this.status == 200) {
            eval(xhttp.responseText);

            logger.log("woodman downloaded, executed and initialized");
            }
        };
        xhttp.open("GET", "https://raw.githubusercontent.com/joshfire/woodman/master/dist/woodman.js", true);
        xhttp.send();
    }
//    includeLoglevel();

    //#endregion

    //#region Leadership

    function civilServiceNotResearched(){
        return !kg.science.get("civil").researched;
    }

    function kittenWithTrait(desiredTrait){
        if(civilServiceNotResearched())
            return null;
        var candidates = kg.village.sim.kittens.filter(k => k.trait && k.trait.name == desiredTrait);
        if(!candidates.length)
            return null;
        var bestBoi = null;
        var bestRank = -1;
        for(var idx = 0; idx < candidates.length; idx++){
            if(candidates[idx].rank > bestRank){
                bestBoi = candidates[idx];
                bestRank = bestBoi.rank;
            }
        }
        return bestBoi;
    }

    // NB: Return old leader in case we need to undo the change
    function doLeaderChangeTrait(desiredTrait){
        if(civilServiceNotResearched())
            return null;
        var previousLeader = kg.village.leader
        changeLeader(kittenWithTrait(desiredTrait));
        return previousLeader;
    }

    function changeLeader(kitten){
        if(civilServiceNotResearched())
            return;
        if(!kitten)
            return;
        if(kg.village.leader == kitten)
            return;
        //console.debug("Chaging leader to ", kitten.name, " ", kitten.surname, " (rank ", kitten.rank, kitten.trait ? kitten.trait.name : "", ")")
        kg.villageTab.censusPanel.census.makeLeader(kitten);
    }

    function craftBonusForLeaderSwitch(craftName){
        for(desiredTrait of leaderDesiredTraitsFromCraft(craftName)){
            if(kittenWithTrait(desiredTrait.trait))
                return desiredTrait.bonus;
        }
        return 0;
    }

    function currentLeaderCraftBonus(craftName){
        if(civilServiceNotResearched())
            return 0;
        if(!kg.village.leader)
            return 0;
        if(!kg.village.leader.trait)
            return 0;
        for(desiredEffect of leaderDesiredTraitsFromCraft(craftName)){
            if(kg.village.leader.trait.name == desiredEffect.trait)
                return desiredEffect.bonus;
        }
        return 0;
    }

    function tradeBonusForLeaderSwitch(){
        if(civilServiceNotResearched())
            return 0;
        if(kg.village.leader && kg.village.leader.trait && kg.village.leader.trait.name == "merchant")
            return 0;
        var burnedParagonRatio = 1 + kg.prestige.getBurnedParagonRatio();
        var leaderRatio = 1;
        if (kg.science.getPolicy("monarchy").researched){
            leaderRatio = 1.95;
        }
        if(kittenWithTrait("merchant"))
            return 0.03 * burnedParagonRatio * leaderRatio;
        return 0;
    }

    function switchLeaderToCraft(craftName){
        if(civilServiceNotResearched())
            return null;
            //console.debug("Attempting to switch leader to craft (so fickle)");
        for(var desiredTrait of leaderDesiredTraitsFromCraft(craftName)){
            // Do we already have leader with this trait?
            if(kg.village.leader && kg.village.leader.trait && kg.village.leader.trait.name == desiredTrait.trait){
                //console.debug("Leader already has trait", desiredTrait.trait);
                return null;
            }
            var newLeader = kittenWithTrait(desiredTrait.trait)
            if(newLeader){
                prevLeader = kg.village.leader;
                //console.debug("Switching from ", prevLeader, " to ", newLeader);
                changeLeader(newLeader);
                return prevLeader;
            } else {
                //console.debug("No kitten with trait", desiredTrait.trait);
            }
        }
        //console.debug("No kitten with any desirable trait");
        return null;
    }

    function leaderDesiredTraitsFromCraft(craftName){
        var burnedParagonRatio = 1 + kg.prestige.getBurnedParagonRatio();
        var leaderRatio = 1;
        if (kg.science.getPolicy("monarchy").researched){
            leaderRatio = 1.95;
        }
        switch(craftName){
            case "wood":
                return [];
            case "plate":
            case "steel":
            case "gear":
            case "alloy":
                return [{trait: "metallurgist", bonus: 0.1 * leaderRatio * burnedParagonRatio}, {trait: "engineer", bonus: 0.05 * leaderRatio * burnedParagonRatio}];
            case "concrete":
            case "eludium":
            case "kerosene":
            case "thorium":
                return [{trait: "chemist", bonus: 0.075 * leaderRatio * burnedParagonRatio}, {trait: "engineer", bonus: 0.05 * leaderRatio * burnedParagonRatio}];
            default: {
                var craftableResource = kg.resPool.get(craftName);
                if(craftableResource.craftable)
                    return [{trait: "engineer", bonus: 0.05 * leaderRatio * burnedParagonRatio}];
                else
                    return [];
            }
        }
    }

    function kittenForPromotion() {
        var fnRankBy = (a, b) => {
            var aIsManager = a.trait && a.trait.name == "manager";
            var bIsManager = b.trait && b.trait.name == "manager";
            if(aIsManager){
                if(bIsManager){
                    if(a.rank > b.rank)
                        return a;
                    else
                        return b;
                } else {
                    return a;
                }
            } else {
                if(bIsManager){
                    return b;
                } else {
                    if(a.rank > b.rank)
                        return a;
                    else
                        return b;
                }
            }
        };
        return kg.village.sim.kittens.reduce(fnRankBy);
    }

    function variableForPromoteLeader(){
        if(civilServiceNotResearched())
            return null;
        var highRank = kittenForPromotion();
        var expToPromote = kg.village.sim.expToPromote(highRank.rank, highRank.rank + 1, highRank.exp)
        // Not much we can do about a lack of experience.
        if(!expToPromote[0])
            return null;
        // We just need to find out how much, hence assume infinite resource.
        var goldToPromote = kg.village.sim.goldToPromote(highRank.rank, highRank.rank + 1, Infinity)
        return {
            name: "PromoteLeader",
            gold: goldToPromote[1],
            utility: 2,
            promotion: 1
        };
    }

    function promoteUnderPlan(){
        if((plan.PromoteLeader || 0) < 1)
            return;
        if(executedPlan.PromoteLeader)
            return;
        if(civilServiceNotResearched())
            return null;
        const timeEnter = performance.now();
        var highRank = kittenForPromotion();
        var expToPromote = kg.village.sim.expToPromote(highRank.rank, highRank.rank + 1, highRank.exp);
        var goldToPromote = kg.village.sim.goldToPromote(highRank.rank, highRank.rank + 1, kg.resPool.get("gold").value);
        if (expToPromote[0] && goldToPromote[0]) {
            bePoetic("promotion");
            execLog.info("Congrats to %s %s who was promoted from rank %i to %i", highRank.name, highRank.surname, highRank.rank, highRank.rank + 1)
            kg.village.sim.promote(highRank);
            executedPlan.PromoteLeader = 1;
        }
        const timeExit = performance.now();
        execLog.log("%s took %ims", "promoteUnderPlan", timeExit - timeEnter);
    }

    function switchLeaderToBuy(btn){
        if(btn.model.prices.find(p => p.name == "faith")){
            return doLeaderChangeTrait("wise")
        }
        else if(btn.tab && (btn.tab.tabId == "Science" || btn.tab.tabId == "Workshop")){
            return doLeaderChangeTrait("scientist")
        }
        return null;
    }

    // function desiredTraitToBuy(btn){
    //     if(btn.model.prices.find(p => p.name == "faith"))
    //         return "wise";
    //     else if (btn.tab && (btn.tab.tabId == "Science" || btn.tab.tabId == "Workshop"))
    //         return "scientist";
    //     return null;
    // }

    function canSwapLeaderToPurchase(btn, feasibilityStudy = true){
        var limitingFactors = limitedResources(btn);
        if(limitingFactors.length == 0)
            return null;
        // Religion Upgrade
        var burnedParagonRatio = 1 + kg.prestige.getBurnedParagonRatio();
        var leaderRatio = 1;
        if (kg.science.getPolicy("monarchy").researched){
            leaderRatio = 1.95;
        }
        if(btn.model.prices.find(p => p.name == "faith")){
            // Current leader is already wise. swapping doesn't help.
            if(kg.village.leader && kg.village.leader.trait && kg.village.leader.trait.name == "wise")
                return null;
            // No wise kitten to swap to.
            if(!kittenWithTrait("wise"))
                return null;
            var reductionRatio = kg.getLimitedDR((0.09 + 0.01 * burnedParagonRatio) * leaderRatio, 1.0);
            for(var factor of limitingFactors){
                // Wisdom only helps with faith and gold.
                if(! (factor.name == "faith" || factor.name == "gold")){
                    //leaderLog.log("needs non faith / gold resource");
                    return null;
                }
                var limRes = kg.resPool.get(factor.name);
                var resourceValue = feasibilityStudy ? limRes.maxValue : limRes.value;
                //leaderLog.log("%s needed %i, resourceValue %i, reductionFactor %f, amountNeededWithReduction %f", factor.name, factor.val, resourceValue, reductionRatio, factor.val * (1 - reductionRatio));
                if(resourceValue < factor.val * (1 - reductionRatio)){
                    // Still over max with swap.
                    //leaderLog.log("%s still over max with swap have %i, needed %i", limRes.name, factor.val * (1 - reductionRatio), resourceValue);
                    return null;
                }
            }
            // Looks like a leader swap helps!
            //leaderLog.log("wisdom helps here",);
            return "wise";
        }
        // Library / Workshop can discount science upgrades.
        else if(btn.tab && (btn.tab.tabId == "Science" || btn.tab.tabId == "Workshop"))
        {
            //leaderLog.log("Evaluating canSwapLeaderToPurchase for %s", buttonId(btn));
            // Current leader is already wise. swapping doesn't help.
            if(kg.village.leader && kg.village.leader.trait && kg.village.leader.trait.name == "scientist")
                return null;
            //leaderLog.log("Leader is not yet scientist");
            // No sciencey kitten to swap to.
            if(!kittenWithTrait("scientist"))
                return null;
            //leaderLog.log("Yes we have a scientist");
            // We can only help science.
            if(limitingFactors.length > 1 || limitingFactors[0].name != "science")
                return null;
            //leaderLog.log("We only need to help science");
            var factor = limitingFactors[0];
            var limRes = kg.resPool.get(factor.name);
            var resourceValue = feasibilityStudy ? limRes.maxValue : limRes.value;
            var reductionRatio = kg.getLimitedDR(0.05 * burnedParagonRatio  * leaderRatio, 1.0); //5% before BP

            //leaderLog.log("Science needed %i, resourceValue %i, reductionFactor %f, amountNeededWithReduction %f", factor.val, resourceValue, reductionRatio, factor.val * (1 - reductionRatio));

            if(resourceValue > factor.val * (1 - reductionRatio)){
                //leaderLog.log("science helps here");
                return "scientist"
            } else {
                // Still over max with swap.
                //leaderLog.log("Still over max with swap");
                return null;
            }
        }
        // Nothing else can be discounted.
        return null;
    }

    function leaderDiscountRatio(btn, resName){
        var burnedParagonRatio = 1 + kg.prestige.getBurnedParagonRatio();
        var leaderRatio = 1;
        if (kg.science.getPolicy("monarchy").researched){
            leaderRatio = 1.95;
        }
        if((isWorkshopButton(btn) || isScienceButton(btn)) &&
            resName == "science" &&
            kittenWithTrait("scientist") &&
            leaderTrait() != "scientist") {
            return 1 - (kg.getLimitedDR(0.05 * burnedParagonRatio  * leaderRatio, 1.0));
        } else if(
            isFaithButton(btn) &&
            (resName == "faith" || resName == "gold") &&
            kittenWithTrait("wise") &&
            leaderTrait() != "wise") {
            return 1 - (kg.getLimitedDR((0.09 + 0.01 * burnedParagonRatio) * leaderRatio, 1.0));
        } else {
            return 1;
        }
    }

    function leaderTrait(){
        if(kg.village.leader && kg.village.leader.trait)
            return kg.village.leader.trait.name;
        return "";
    }

    //#endregion

    //#region Faith

    function getApocryphaResetBonusByTier(tTier){
        var bonusRatio = 1.01;
        // getApocryphaResetBonus religion.js ~line 1107
        //100% Bonus per Transcendence Level
        if (kg.religion.getRU("transcendence").on) {
            bonusRatio *= Math.pow((1 + tTier), 2);
        }
        return (kg.religion.faith / 100000) * 0.1 * bonusRatio;
    }

    function canTranscend (){
        return kg.religionTab.visible &&
            kg.religionTab.transcendBtn &&
            kg.religionTab.transcendBtn.model.visible;
    }

    // How many times should I transcend before adoring (if I was to adore right now)
    function shouldTranscendBeforeAdore(){
        // Is transcend even a valid action?
        if(!canTranscend()){
            return 0;
        }

        var transcendTotalPriceCurrent = kg.religion._getTranscendTotalPrice(kg.religion.transcendenceTier);
        var apocBonusNow = getApocryphaResetBonusByTier(kg.religion.transcendenceTier);
        var timesToTranscend = 1;
        while(true) {
            var newTranTier = kg.religion.transcendenceTier + timesToTranscend;
            var transcendPriceInFaithRatio = kg.religion._getTranscendTotalPrice(newTranTier) - transcendTotalPriceCurrent;

            if(transcendPriceInFaithRatio > kg.religion.faithRatio){
                // Can't afford transcend to yet another level.
                return timesToTranscend - 1;
            }

            var apocBonusAfter = getApocryphaResetBonusByTier(newTranTier);
            // transcend if we get our  "faithRatio" back immediately.
            if (apocBonusAfter < apocBonusNow){
                // Transcending again not beneficial.
                return timesToTranscend - 1;
            }
            // Try another level.
            timesToTranscend++;
        }
    }

    function canAdore (){
        return kg.religionTab.visible &&
            kg.religionTab.adoreBtn &&
            kg.religionTab.adoreBtn.model.visible;
    }

    function shouldIAdoreBeforePraise(){
        if(!canAdore()){
            return false;
        }
        // Is adore even a valid action?
        // If I were to hypothetically adore I would transcend this many times to maximise it
        var numTranscends = shouldTranscendBeforeAdore();
        var newFaithRatio = getApocryphaResetBonusByTier(kg.religion.transcendenceTier + numTranscends);
        var newApocBonusRatio = kg.getUnlimitedDR(newFaithRatio, 0.1) * 0.1;

        var currentWorship = kg.religion.faith;
        var worshipPerSecond = kg.calcResourcePerTick("faith", 0) * (1 + newApocBonusRatio);
        var bankedWorship = game.resPool.get("faith").value * (1 + newApocBonusRatio);

        var maxTimeToRestoreWorshipS = (currentWorship - bankedWorship) / worshipPerSecond;
        var willingToWaitS = maxTimeToRecoverWorshipAfterAdoreHours * 60 * 60;
        return maxTimeToRestoreWorshipS < willingToWaitS;
    }

    function executeTranscendsNow(){
        if(canTranscend()){
            var numTranscends = shouldTranscendBeforeAdore();
            for(trNum = 0; trNum < numTranscends; trNum++){
                bePoetic("transcend");
                kg.religion.transcend();
            }
        }
    }

    function executeAdoreNow(){
        if(!canAdore()){
            return;
        }
        executeTranscendsNow();
        bePoetic("adore");
        kg.religionTab.adoreBtn.buttonContent.click();
    }

    function variableForPraiseSun(){
        if(!kg.religionTab.visible)
            return null;
        const halfFaith = kg.resPool.get("faith").maxValue / 2;
        const additionalWorship = halfFaith * (1 + kg.religion.getApocryphaBonus());
        // What a crumbily named variable :-(. Hysterical raisins I suppose.
        const worship = kg.religion.faith;
        const nextUnlockBtn = kg.religionTab.rUpgradeButtons.find(ru => !ru.model.visible);
        const revolutionBtn = kg.religionTab.rUpgradeButtons.find(ru => ru.id == "solarRevolution");
        // Utility for unlocking another option to work towards.
        const worshipToUnlockNextOption = nextUnlockBtn ? nextUnlockBtn.model.metadata.faith - worship: -1;
        const howFarDoesPraiseGetUs = Math.min(1, additionalWorship / worshipToUnlockNextOption);
        //var utility = nextUnlockBtn ? howFarDoesPraiseGetUs * buttonUtility(nextUnlockBtn) * utilityFactorForInfeasible : 0;
        var utility = nextUnlockBtn ? howFarDoesPraiseGetUs : 0;
        faithLog.log("Utility for unlocks: %f (additionalWorship: %f, worshipToUnlockNextOption: %f, howFarDoesPraiseGetUs: %f)", utility, additionalWorship, worshipToUnlockNextOption, howFarDoesPraiseGetUs);
        if(revolutionBtn.model.metadata.val > 0){
            const currentSolRevBonus = calculateSolarRevolutionRatio(worship);
            const predictedSolRevBonus = calculateSolarRevolutionRatio(worship + additionalWorship);
            const extraSolRevBonusPP = predictedSolRevBonus - currentSolRevBonus;
            // How much is another 1% production worth? Quite a damn lot!
            const utilityForSolRev = extraSolRevBonusPP * 100 * globalProductionUtility;
            faithLog.log("Utility for solar revolution bonus: %f (currentSolRevBonus: %f, predictedSolRevBonus: %f)", utilityForSolRev, currentSolRevBonus, predictedSolRevBonus);
            utility += utilityForSolRev;
        }
        return {
            name: "PraiseTheSun",
            faith: halfFaith,
            utility: utility
        }
    }

    // religion.js getSolarRevolutionRatio line 1068
    function calculateSolarRevolutionRatio (worship) {
        var uncappedBonus = kg.religion.getRU("solarRevolution").on ? kg.getUnlimitedDR(worship, 1000) / 100 : 0;
        return kg.getLimitedDR(uncappedBonus, 10 + kg.getEffect("solarRevolutionLimit") + (kg.challenges.getChallenge("atheism").researched ? (kg.religion.transcendenceTier) : 0)) * (1 + kg.getLimitedDR(kg.getEffect("faithSolarRevolutionBoost"), 4));
    }

    function praiseUnderPlan(){
        if(!plan)
            return;
        var plannedPraise = Math.floor(plan["PraiseTheSun"] || 0);
        var praiseToDo = plannedPraise - (executedPlan["PraiseTheSun"] || 0);
        if(praiseToDo <= 0)
            return;
        var faithAmount = kg.resPool.get("faith").value;
        var halfFaith = kg.resPool.get("faith").maxValue / 2;
        var praisesAvailable = faithAmount / halfFaith;
        //console.log("praiseToDo: %i, faithAmount: %i, halfFaith: %i, praisesAvailable: %i", praiseToDo, faithAmount, halfFaith, praisesAvailable);
        if(praisesAvailable > 1){
            if(shouldIAdoreBeforePraise()){
                executeAdoreNow();
            }
            faithLog.info("About to paise %i ", praisesAvailable);
            bePoetic("praise");
            kg.religionTab.praiseBtn.buttonContent.click();
            executedPlan.PraiseTheSun = (executedPlan.PraiseTheSun || 0) + praisesAvailable;
        }
    }

    function variableForSacrifice(){
        if(!kg.religionTab.visible)
            return null;
        var zigs = kg.bld.get("ziggurat").val;
        if(kg.bld.get("ziggurat").val == 0)
            return null;
        var su = {
            name: "SacrificeUnicorns",
            unicorns: 2500,
            tears: -zigs
        }
        // Tears are a luxury.
        if(kg.resPool.get("tears").value == 0)
            su.utility = 0.1;
        return su;
    }

    function sacrificeUnderPlan(){
        if(!plan)
            return;
        if(!kg.religionTab.visible)
            return null;
        if(kg.bld.get("ziggurat").val == 0)
            return null;
        var executedSacs = executedPlan["SacrificeUnicorns"] || 0;
        var plannedSac = Math.floor(plan["SacrificeUnicorns"] || 0);
        var sacsDesired = plannedSac - executedSacs;
        var sacsPossible = Math.floor(kg.resPool.get("unicorns").value / 2500.0);
        var sacsToDo = Math.min(sacsPossible, sacsDesired)
        if(sacsToDo <= 0){
            return;
        }
        bePoetic("unicorn");
        for(var i = 0; i < sacsToDo; i++){
            faithLog.info("I will bathe in unicorn tears!");
            kg.religionTab.sacrificeBtn.buttonContent.click()
        }
        executedPlan["SacrificeUnicorns"] = executedSacs + sacsToDo;
    }

    //#endregion

    //#region Utilities

    // Get an identifiable id string for a button to tie solver together with buttons in ui
    function debug(f, logger){
        const origLevel = logger.level;
        logger.level = "all";
        const timeEnter = performance.now();
        var rv = f();
        const timeExit = performance.now();
        logger.log("Took %i ms", (timeExit - timeEnter));
        logger.level = origLevel;
        if(rv)
            return rv;
    }

    function buttonId(btn){
        if(!btn)
            return "null";
        if(btn.name)
            return btn.name;
        if(btn.race)
            return btn.race.name + "Embassy";
        if(btn.opts.building)
            return btn.opts.building;
        if(btn.opts.id)
            return btn.opts.id;
        return btn.opts.name;
    }

    function buttonLabel(btn){
        if(!btn)
            return "null";
        if(btn.model && btn.model.metadata && btn.model.metadata.label){
            var baseLabel = btn.model.metadata.label;
            if(btn.race){
                return btn.race.title + " " + baseLabel;
            } else {
                return baseLabel;
            }
        } else {
            return buttonId(btn);
        }
    }

    function sciencePrice(a){
        return a.prices.find(p => p.name == "science").val || 0;
    }

    function mostAdvancedResearch(collection){
        var researched = collection.filter(u => u.researched);
        if(!researched.length)
            return "";
        return researched.sort((a, b) => sciencePrice(b) - sciencePrice(a))[0].label;
    }


    function recordHistory(){
        var historyString = `${kg.stats.getStatCurrent("timePlayed").val.padEnd(18)}${kg.stats.getStat("totalResets").val + 1}.${kg.calendar.year}`;
        historyString = historyString.padEnd(28);
        historyString += `${kg.resPool.get("kittens").maxValue} kittens ${mostAdvancedResearch(kg.science.techs)}, ${mostAdvancedResearch(kg.workshop.upgrades)}`
//         historyString += `

// `;
//         var data = kg.save();
//         data = JSON.stringify(data);
//         var encodedData = kg.compressLZData(data);
//         historyString += encodedData;
        // if(kg.spaceTab.visible){
        //     historyString +=
        // }
        return historyString;
        logger.info(historyString);
    }

    function plannedUtilities(onlyBuildables = true, topN = 5, orderBy = "quantityChange"){
        var pu = [];
        var lastPlan = historicPlans.get(1);
        for(var planItem in plan){
            //logger.log(planItem)
            if(model.variables[planItem] && model.variables[planItem].utility){
                if(onlyBuildables && !(planItem.startsWith("Build|")))
                    continue;
                //logger.log(plan[planItem])
                pu.push({
                    name: planItem,
                    utilityPerItem: model.variables[planItem].utility.toFixed(2),
                    quantity: plan[planItem].toFixed(2),
                    previousQuantity: (lastPlan ? (lastPlan[planItem] || 0) : 0).toFixed(2),
                    quantityChange: (plan[planItem] - (lastPlan ? (lastPlan[planItem] || 0) : 0)).toFixed(2),
                    totalUtility: (model.variables[planItem].utility * plan[planItem]).toFixed(2)});
            }
        }
        pu.sort(function(a, b){return b[orderBy]-a[orderBy]});
        if(topN > 0)
            pu.length = topN;
        return pu;
    }

    function utilityProgress(btn){
        var hist = [];
        for(var plan of historicPlans.toArray()){
            hist.push((plan[btn] || 0).toFixed(2));
        }
        return hist;
    }

    function mostRecentPurchases(){
        var purchases = [];
        for(var eh of historicExecution.toArray()){
            if(eh){
                for(var item in eh){
                    if(item.startsWith("Build|"))
                        purchases.push({time: eh.validTo.toLocaleTimeString(), item: item});
                }
            }
        }
        return purchases;
    }

    function CircularBuffer(length){

        var pointer = 0, buffer = new Array(length), itemsPushed = 0;

        return {

        get  : function(key){return buffer[((pointer - 1) - key + length) % length];},
        push : function(item){
            buffer[pointer] = item;
            pointer = (length + pointer + 1) % length;
            itemsPushed++;
        },
        toArray : function() {
            var retArray = [];
            for(var idx = 0; idx < Math.min(length, itemsPushed); idx++){
                retArray.push(this.get(idx));
            }
            return retArray;
        }
        };
    };

    function clone(obj){
        return JSON.parse(JSON.stringify(obj));
    }

    function shuffle(array) {
        let currentIndex = array.length,  randomIndex;

        // While there remain elements to shuffle.
        while (currentIndex != 0) {

        // Pick a remaining element.
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;

        // And swap it with the current element.
        [array[currentIndex], array[randomIndex]] = [
            array[randomIndex], array[currentIndex]];
        }

        return array;
    }

    // https://stackoverflow.com/questions/25888963/min-by-max-by-equivalent-functions-in-javascript
    // const pluck = function(object, plucker) {
    //     const t = typeof plucker;
    //     switch (t) {
    //       case 'function':
    //         return plucker(object)
    //       case 'number':
    //       case 'string':
    //         return object[plucker]
    //       default:
    //         throw new TypeError(`Invalid type for pluck: ${t}`)
    //     }
    //   }

    //   Array.prototype.extremumBy = function(plucker, extremum) {
    //     return this.reduce(function(best, next) {
    //       var pair = [ pluck(next, plucker), next ];
    //       if (!best) {
    //         return pair;
    //      } else if (extremum.apply(null, [ best[0], pair[0] ]) == best[0]) {
    //         return best;
    //      } else {
    //         return pair;
    //      }
    //    },null)[1];
    //  }

    //  // the only difference between minBy and maxBy is the ordering
    // // function, so abstract that out
    // Array.prototype.minBy = function(fn) {
    //     return this.extremumBy(fn, Math.min);
    //   };

    //   Array.prototype.maxBy = function(fn) {
    //     return this.extremumBy(fn, Math.max);
    //   };


    //#endregion Utilities

    //#region Reset

    var planningForResetSince = null;
    function shouldStartResetCountdown(){
        if(planningForResetSince){
            return planningForResetSince;
        }
        var paragon = kg.resPool.get("paragon").value;
        var totalParagon = paragon + kg.resPool.get("burnedParagon").value;
        if(totalParagon == 0){
            // First reset after Concrete Huts is a typical kind of time.
            // Researching apocripha should also be a priority as epiphany carries over.
            if(kg.workshop.get("concreteHuts").researched && kg.religion.getRU("apocripha").on){
                planningForResetSince = new Date();
            }
        } else {
            // Lets try to increase paragon by specifed ratio.
            var resetParagon = kg.getResetPrestige().paragonPoints;
            if(resetParagon >= (paragon * paragonPerResetRatio) && kg.religion.getRU("apocripha").on){
                planningForResetSince = new Date();
            }
        }
        if(planningForResetSince){
            bePoetic("the end of the world");
        }
        return planningForResetSince;
    }

    function executeResetLogic(){
        var planningSince = shouldStartResetCountdown();
        if(!planningSince)
            return;
        const resetTime = addMinutes(planningForResetSince, 20);
        const timeLeftSecs = (resetTime - new Date()) / 1000;

        if(timeLeftSecs <= 0)
        {
            execLog.warn("Goodbye cruel world!");
            kg.religion.praise();
            executeAdoreNow();
            kg.reset();
            return;
        }

        const reminderPointSeconds = [1200, 600, 300, 240, 180, 120, 60, 30];
        var uiReminder = reminderPointSeconds.find(rp => timeLeftSecs <= rp && (timeLeftSecs + executeIntervalSeconds > rp));
        if(uiReminder) {
            timeLeftSecs = uiReminder;
        }
        var diffMins = Math.floor(timeLeftSecs / 60);
        var diffSeconds = Math.floor(timeLeftSecs - (diffMins * 60));
        if(diffMins)
            diffMins += " mins"
        if(diffSeconds)
            diffSeconds = " " + diffSeconds + " seconds"
        else
            diffSeconds = ""
        var msg = "THE END IS NIGH. Reset in approximately " + diffMins + diffSeconds
        execLog.warn(msg);
        if(uiReminder){
            kg.msg("9Souls: " + msg);
        }
    }

    function addMinutes(date, minutes) {
        return new Date(date.getTime() + minutes*60000);
    }

    function writePoetry(poetryResponse, searchTerm){
        console.log(poetryResponse);
        // Bad / no data. Meh.
        if(poetryResponse.status != 200 ||
            !poetryResponse.response ||
            !poetryResponse.response.length
            ){
            return;
        }
        var poemData = poetryResponse.response[0];
        var context = findContext(poemData.lines, searchTerm);
        // Meh.
        if(!context){
            return;
        }
        nextWritePoetry = addMinutes(new Date(), 2);
        context.reverse().forEach(l => kg.msg("    " + l, null, "9souls", true));
        kg.msg("9Souls: " + poemData.title + " by " + poemData.author, null, "9souls");
    }

    var poetryRecited = new CircularBuffer(15);
    var nextWritePoetry = null;

    function bePoetic(searchTerm){
        if(!GM_xmlhttpRequest){
            return;
        }
        if(poetryRecited.toArray().includes(searchTerm)){
            return;
        }
        if(nextWritePoetry && nextWritePoetry > new Date()){
            // Don't spam - this is just for fun after all.
            return;
        }
        poetryRecited.push(searchTerm);
        GM_xmlhttpRequest({
            method: "GET",
            url: "https://poetrydb.org/lines,random/" + searchTerm + ";1",
            nocache: true,
            responseType: "json",
            onload: response => writePoetry(response, searchTerm)
        });
    }

    function findContext(poemLines, context){
        var lineIdx = poemLines.findIndex(l => l.includes(context));
        if(lineIdx < 0)
            return null;
        var contextStartLine = lineIdx;
        var contextStart = poemLines[lineIdx].indexOf(context);
        var contextEndLine = lineIdx;
        var contextEndChar = contextStart;
        while (true) {
            var endCtxChar = indexOfAny([".", "?", "!"], poemLines[contextEndLine], contextEndLine == lineIdx ? contextStart : 0);
            if(endCtxChar > -1){
                contextEndChar = endCtxChar;
                break;
            } else {
                contextEndChar = poemLines[contextEndLine].length
            }
            if(contextEndLine >= lineIdx + 2) {
                break;
            }
            contextEndLine++;
        }
        while(true){
            var startCtxChar = lastIndexOfAny([".", "?", "!"], poemLines[contextStartLine], contextStartLine == lineIdx ? contextStart : -1);
            if(startCtxChar > -1){
                contextStart = startCtxChar;
                break;
            } else {
                contextStart = -1;
            }
            if(contextStartLine == 0 || contextStartLine <= lineIdx - 2) {
                break;
            }
            contextStartLine--;
        }
        console.log(contextStartLine, contextStart)
        console.log(contextEndLine, contextEndChar)
        var lines = poemLines.slice(contextStartLine, contextEndLine + 1);
        lines[0] = lines[0].slice(contextStart + 1);
        lines[lines.length - 1] = lines[lines.length - 1].slice(0, contextEndChar);
        return lines;
    }

    function lastIndexOfAny(needles, haystack, searchBefore = -1){
        if(searchBefore != -1){
            haystack = haystack.slice(0, searchBefore);
        }
        return needles.reduce((prev, needle) => {
            var idx = haystack.lastIndexOf(needle);
            if(idx > prev){
                return idx;
            }
            return prev;
        }, -1);
    }

    function indexOfAny(needles, haystack, startAt = 0){
        return needles.reduce((prev, needle) => {
            var idx = haystack.indexOf(needle, startAt);
            if(idx >= 0 && (idx < prev || prev == -1)){
                return idx;
            }
            return prev;
        }, -1);
    }

    //#endregion

    //#region Sell

    function getSellable(){
        return kg.bldTab.children.slice(2).filter(b =>
            b.model.showSellLink &&
            b.model.metadata.val > 0 &&
            b.sellHref
            );
    }

    function variableFromSellable(button, outOfReach){

        var id = buttonId(button);
        buyableLog.log("%s: Constructing sell variable", id);
        const utility = -buttonUtility(button, outOfReach)
        buyableLog.log("%s: Utility %f", id, utility.toFixed(2));
        const sellVariable = {
            name: "Sell|" + id,
            utility: utility
        }
        sellVariable[id + "Sell"] = 1;
        for(pe of button.model.metadata.prices){
            const lastCost = pe.val *  Math.pow(button.model.metadata.priceRatio, button.model.metadata.val - 1);
            const refundedAmount = button.model.refundPercentage * lastCost;
            buyableLog.log("%s: Resource %s lastCost %f refund amt %f", id, pe.name, lastCost.toFixed(2), refundedAmount.toFixed(2));
            sellVariable[pe.name] = -refundedAmount;
        }
        buyableLog.log(sellVariable)
        return sellVariable;
    }

    function executeSellItems(){
        var sales = segmentPlan().Sell;
        if(!sales)
            return;
        for(var sellItemId in sales){
            if(sales[sellItemId] < buyThreshold)
                continue;
            // Ok I suppose we're really doing this!
            var sellBtn = getSellable().find(s => buttonId(s) == sellItemId);
            if(!sellBtn || !sellBtn.sellHref || !sellBtn.sellHref.link)
            kg.msg('9Souls: Selling ' + buttonLabel(sellBtn) + "!");
            executeCrafts();
            sellBtn.sellHref.link.click();
            executedPlan["Sell|" + sellItemId] = 1;
            planNow();
        }
    }

    //#endregion

    //#region UI

    var btnBegin;
    var planDisplay;
    var historySpan;
    var modelDisplay;

    function addElement(parent, elementName, elementAttrs, innerText){
        const element = document.createElement(elementName);
        if(elementAttrs){
            Object.keys(elementAttrs).forEach(k => {
                element.setAttribute(k, elementAttrs[k]);
            });
        }
        if(innerText){
            element.innerText = innerText;
        }
        let parentNode;
        switch (typeof parent){
            case "string":
                parentNode = document.getElementById(parent);
                break;
            case "object":
                parentNode = parent;
                break;
            case "undefined":
            default:
                parentNode = document.getElementsByTagName("body")[0];
                break;
        }
        parentNode.appendChild(element);
        return element;
    }

    function makeUi(){
        if(document.getElementById("9s"))
            return;
        var scriptBox = addElement("leftColumn", "div", {id: "9s"});
        addElement(scriptBox, "style", {}, `
.9s-ui {
    display: flex;
    font-size: 14px;
}
.9s-btn {
    height: 30px;
    width: 48.5px;
}
.9s-heading {

}
        `);
        addElement(scriptBox, "h5", {class: "9s-heading"}, "9-Souls: Kitten Auomation Engine");
        var scriptUi = addElement(scriptBox, "div", {class: "9s-ui"});
        btnBegin = addElement(scriptUi, "button", {id: "9s-startStop" }, "Go!");
        btnBegin.addEventListener("click", uiStopStart, true);
        var planDetails = addElement(scriptUi, "details", {id: "9s-plan"});
        addElement(planDetails, "summary", null, "Current Plan:");
        planDisplay = addElement(planDetails, "ul");

        var modelDetails = addElement(scriptUi, "details", {id: "9s-model"});
        addElement(modelDetails, "summary", null, "Current Model:");
        modelDisplay = addElement(modelDetails, "ul");

        var historyDiv = addElement("rightColumn", "div");
        historySpan = addElement(historyDiv, "span", {id: "9s-history"});
    }

    function updateUi(){
        updatePlanUi();
        updateModelUi();
        historySpan.innerText = recordHistory();
    }

    function updateModelUi(){

    }

    function updatePlanUi(){
        const segmentedPlan = segmentPlan(plan);
        const segmentedExecution = segmentPlan(executedPlan);
        if(!planDisplay){
            return;
        }
        var planDescription = describePlanForUi(segmentedPlan, segmentedExecution);
        planDisplay.innerHTML = planDescription;
    }

    function describePlanForUi(segmentedPlan, segmentedExecution){
        return Object.keys(segmentedPlan).sort().reduce((descString, planKey) => {
            descString += "<li>" + planKey;
            if(typeof segmentedPlan[planKey] === "object"){
                descString += describePlanPart(segmentedPlan[planKey], segmentedExecution[planKey]);
            } else {
                descString += ":" + segmentedPlan[planKey].toFixed(2);
            }
            descString += "</li>";
            return descString;
        }, "");
    }

    function describePlanPart(planPart, segmentedExecutionPart){
        return Object.keys(planPart).sort().reduce((descString, planPartKey) => {
            descString += "<li>" + planPartKey + ":" + planPart[planPartKey].toFixed(2);
            if(segmentedExecutionPart && segmentedExecutionPart[planPartKey]){
                descString += " (" + segmentedExecutionPart[planPartKey] + ")"
            }
            return descString + "</li>";
        }, "<ul>") + "</ul>";
    }

    function uiStopStart(event){
        if(isRunning){
            stop();
            event.target.innerText = "Go!";
        } else {
            go();
            event.target.innerText = "Stop!";
        }
    }

    //#endregion

    return {
        go: go,
        stop: stop,
        includeLoglevel: includeLoglevel,
        includeSolver: includeSolver,
        recordHistory: recordHistory,
        makeUi: makeUi,

        currentPlan: function () { return plan },
        currentModel: function () { return model },
        executedPlan: executedPlan,
        segmentPlan: segmentPlan,

        baseUtilityMap: baseUtilityMap,

        bePoetic: bePoetic
    };
}();

if(!GM_addElement) {
    // Loaded from console like the old days. Include the scripts that tamper monkey "requires".
    unsafeWindow.nineSouls.includeLoglevel();
    unsafeWindow.nineSouls.includeSolver();
}
unsafeWindow.nineSouls.makeUi();
