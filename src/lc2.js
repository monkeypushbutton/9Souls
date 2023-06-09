// ==UserScript==
// @name         9Souls
// @namespace    https://github.com/monkeypushbutton/9Souls
// @version      0.1
// @description  An AI for bloodrizer's Kittens Game, capable of performing most actions.
// @author       monkeypushbutton@gmail.com
// @match        https://kittensgame.com/web/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @GRANT        GM_setValue
// @grant        GM_addElement
// @require      https://unpkg.com/javascript-lp-solver@0.4.24/prod/solver.js
// @require      https://raw.githubusercontent.com/joshfire/woodman/master/dist/woodman.js
// ==/UserScript==

// TODO: Kittens massacre in year 1 due to building too many huts. Sad but not a deal breaker.
// TODO: UI often doesn't refresh after script takes an action. Smelters going on and off are a case in point.
// TODO: Pollution. Incentivise not increasing levels.
// TODO: Space haven't got there in playthroughs yet
// TODO: Upgradable builings (solar farm etc)
// TODO: Lazy crafting. Only perform desired crafts when resources near limit, or in process of actually using them
// Rationale: We might happen to improve craft efficiency first and hence will end up being more efficient overall.
// especially noticable with Tears via Ziggurats, but generally seems a sound idea.

// TODO: Check if below TODO is still valid after resCap constraints?
// TODO: LP Still wants to assign kittens to e.g. scientist when resource is at max at certain points. I'm manually correcting for it right now, which sucks.

// NB: Season is ~ 200 seconds long. 

//(function() {
    // How long between executions of plan. 
    // Setting this too low will be spammy and may slow game.
    // Setting too high may cause missed observations, more 0 / max resource inefficiencies etc.
    var executeIntervalSeconds = 5;

    // How much history should we keep?
    var planHistory = 5;
    var purchaseHistory = 50;
    var tradeHistory = 50;

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
    // Or even more for safety if you have murdering kittens I suppose.
    // TODO: Script is murdering kittens with gay abandon in cold winters. Once that is fixed, this can be reduced.
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

    // How much additional utility is granted for expanding storage to build things that are currently 
    // out of reach (as a multiplier of the basic utility of the infeasible thing)
    var utilityFactorForInfeasible = 0.075;

    // Toggle logic to try and stop script from assiging kittens to dead jobs.
    // May cause longer term deadlocks when science gets evently split between jobs making little progress?
    // 0 = off completely, max amount of resources not considered when planning e.g. job allocation.
    // < 1 Highly not recommended
    // 1 Resources constrainted to max value in utility function.
    // > 1 Multiply resource cap by this and use that as constraint, kind of a half way house.
    var contrainResourceCap = 0;

    // Latest version of the game this script was tested / developed against.
    // See game.telemetry, checked at startup. 
    var testedVersion = {version: 1492, revision: 1218}

    var eventLoops = {
        execHandle: undefined,
        gatherHandle: undefined
    };

    //#region Control Of event loops
    function go(checkVersion = true) {
        // Important to not stall when choosing a policy upgrade.
        game.opts.noConfirm = true;
        if(checkVersion && !checkVersionIsTested()){
            return;
        }
        ensureTabsRendered();
        restartExecLoop();
    }

    function checkVersionIsTested() {
        if(game.telemetry.version != testedVersion.version || game.telemetry.buildRevision != testedVersion.revision )
        {
            logger.warn("Game version %s.r%s does not match tested version %s.r%s. Here be dragons. Make a backup and call go(false) to proceed.",
            game.telemetry.version,
            game.telemetry.buildRevision,
            testedVersion.version,
            testedVersion.revision);
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
        for(var handle in eventLoops){
            if(eventLoops[handle]){
                console.log("Stopping " + handle);
                stopLoop(handle);
            }
        }
    }

    function controlGatherLoop(){
        var nipInfo = game.resPool.resources[0];
        if(nipInfo.value > 1000 || nipInfo.perTickCached > 2){
            stopLoop('gatherHandle');
        }
        else 
            restartGatherLoop();
    }

    function restartGatherLoop(){
        stopLoop('gatherHandle');
        // ~7 nip per second, about as fast as I can spam click.
        eventLoops.gatherHandle = setInterval(() => game.bldTab.children[0].buttonContent.click(), 150);
    }

    function restartExecLoop(){
        stopLoop('execHandle');
        executePlanNow();
        eventLoops.execHandle = setInterval(executePlanNow, executeIntervalSeconds * 1000);
    }

    function ensureTabsRendered(){
        gamePage.villageTab.render();
        gamePage.libraryTab.render();
        gamePage.workshopTab.render();
        gamePage.bldTab.render();
        gamePage.diplomacyTab.render();
        gamePage.religionTab.render();
        gamePage.spaceTab.render();
        gamePage.timeTab.render();
    }

    //#endregion

    //#region Execution

    function executePlanNow(timesBought = 0){
        execLog.log("Executing");
        executeResetLogic();
        if(!plan){
            planNow();
        }
        if(gamePage.calendar.season != plannedSeason){
            execLog.log("Replanning (season)");
            planNow();
        }
        if(getBuyables().length != plannedButtons.length){
            //Mainly so we don't have to wait a whole season to build a field :-)
            execLog.log("Replanning (possibilities changed)");
            planNow();
        }
        if(game.resPool.get("kittens").value != plannedKittens){        
            //Mainly so we don't have to wait a whole season to build a field :-)
            execLog.log("Replanning (kittens changed)");
            planNow();
        }
        //console.time("executePlan");
        // Note that actions that produce resources (hunt, trade, sell) should re-execute crafting
        executeCrafts();

        observeTheSky();
        controlGatherLoop();
        executeHunts();
        
        executeExplore();
        executeTrades();

        executeSellItems();
        executeIncrementableBuilding();
        executeToggleBuildings();

        praiseUnderPlan();
        sacrificeUnderPlan();

        assignJobs();
        executeFestival();
        promoteUnderPlan();
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
    }

    function observeTheSky(){    
        if(gamePage.calendar.observeBtn){
            execLog.log("Observing...")
            gamePage.calendar.observeBtn.click();
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

    // We use these variables to track if we need to replan. Do not change.
    var plannedSeason = -1;
    var plannedKittens = 0;
    var plannedButtons = [];
    var reservedFarmers = 0;

    function planNow(){
        plannedSeason = gamePage.calendar.season;
        plannedButtons = getBuyables();
        plannedKittens = game.resPool.get("kittens").value;
        model = buildModel();
        historicModels.push(plan);
        const timeEnterSolve = performance.now();
        plan = solver.Solve(model);
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
    }

    function planHorizonSeconds(){
        return (100 - gamePage.calendar.day) * 2;
    }

    function secretUnlocks() {
        // NB: Most of these are now implemented by adding a utility to the action we want to take at a certain point
        // e.g. refine wood early game, assign a kitten to minerals etc etc.

        // What other secrets are out there!?
        return [];
    }

    function limitedResources(btn){
        //console.log(buttonId(btn), btn)
        var limitedResources = []
        for(cost of btn.model.prices){
            var resMax = game.resPool.get(cost.name).maxValue
            if(cost.name == "catnip"){
                resMax -= reservedNipAmount();
            }
            if(resMax && resMax < cost.val)
                limitedResources.push(cost)
        }
        return limitedResources;
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
        if(btn.model && btn.model.metadata)
            return game.religion.religionUpgrades.find(ru => ru.name == btn.model.metadata.name);
        return false;
    }

    function isBuilding(btnId){
        return game.bld.buildingsData.find(b => buttonId(b) == btnId)
    }

    function isWorkshopButton(btn){
        return btn.tab && btn.tab.tabId == "Workshop";
    }

    function canAffordHowManyNow(btn){
        var limitedAmount = Infinity
        //console.debug("Checking if I can afford ", buttonId(btn))
        for(pe of btn.model.prices){
            const reservedRes = pe.name == "catnip" ? reservedNipAmount() : 0;
            const needed = pe.val * leaderDiscountRatio(btn, pe.name);
            const resPoolRes = gamePage.resPool.resourceMap[pe.name].value;
            const availableResources = Math.max(resPoolRes - reservedRes, 0)
            const ratio = availableResources / needed
            if(ratio < 1) {
                //console.debug("I don't have enough ", pe.name, " need ", pe.val, " have ", availableResources, reservedRes == 0 ? "" : " (not including " + reservedRes + " reserved) ")
                return ratio;
            }
            //console.debug("I have enough ", pe.name, " need ", pe.val, " have ", resPoolRes)
            if(ratio < limitedAmount)
                limitedAmount = ratio
        }
        return limitedAmount;
    }

    function buildModel() {
        const timeEnter = performance.now();
        // TODO: Build a model with steamworks on or off. Plan twice and execute plan with best utility.
        model = {
            optimize: "utility",
            opType: "max",
            variables: {},
            constraints: {}
        };
        var outOfReach = getBuyables(false);
        for(var btn of getBuyables()){
            var buyVariable = variableFromButton(btn, outOfReach);
            model.variables[buyVariable.name] = buyVariable;
        }
        // for(var sellBtn of getSellable()){
        //     var sellVariable = variableFromSellable(sellBtn, outOfReach);
        //     model.variables[sellVariable.name] = sellVariable;
        //     model.constraints[buttonId(sellBtn) + "Sell"] = { max: 1 };
        // }
        for(var job of getJobAssignments()){
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
            var bldName = buttonId(toggleBld);
            var bldNumVar = variableFromToggleableBuilding(toggleBld);
            model.variables[bldNumVar.name] = bldNumVar;
            model.constraints[bldName] = { max: 1 };
        }
        for(var res of game.resPool.resources) {
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
        if(promoteVariable)
            model.variables[promoteVariable.name] = promoteVariable;
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
        }
        if(game.science.get("electricity").researched){
            model.constraints.energy = {max: 0}
        }
        reservedFarmers = reserveFarmers();
        model.constraints.kittens.max -= reservedFarmers;
        const timeExit = performance.now();
        logger.log("%s took %ims", "buildModel", timeExit - timeEnter);
        return model;
    }

    function segmentPlan(){
        var sp = {};
        var notCopied = ["bounded", "feasible", "isIntegral", "result"];
        for(f in plan){
            if(notCopied.find(nc => nc == f))
                continue;
            var parts = f.split("|");
            if(parts.length == 1)
                sp[f] = plan[f];
            else {
                if(!sp[parts[0]])
                    sp[parts[0]] = {};
                sp[parts[0]][parts[1]] = plan[f];
            }
        }
        return sp;
    }

    //#endregion Plan

    //#region Buyables
    function getBuyables(feasible = true) {
        //console.time("getBuyables");
        // console.time("bldTab.render");
        // gamePage.bldTab.render();    
        // console.timeEnd("bldTab.render");
        buyable = gamePage.bldTab.children.slice(2).filter(b => 
            isFeasible(b) == feasible && (
                !planningForResetSince || 
                b.model.metadata.effects.maxKittens || 
                game.bldTab.bldGroups.find(bg => bg.group.name == "storage").group.buildings.find(build => build == buttonId(b))
            )
        );

        if(planningForResetSince)
            return buyable;

        if(gamePage.workshopTab.visible){
            // gamePage.workshopTab.render();
            buyable = buyable.concat(gamePage.workshopTab.buttons.filter(b => b.model.visible && isFeasible(b) == feasible && !b.model.metadata.researched));
        }
        if(gamePage.libraryTab.visible){
            // console.time("libraryTab.render");
            // gamePage.libraryTab.render();
            // console.timeEnd("libraryTab.render");
            buyable = buyable.concat(gamePage.libraryTab.buttons.filter(b => b.model.visible && isFeasible(b) == feasible && !b.model.metadata.researched));
            if(gamePage.libraryTab.policyPanel.visible){
                buyable = buyable.concat(gamePage.libraryTab.policyPanel.children.filter(b => b.model.visible && isFeasible(b) == feasible && !b.model.metadata.researched && !b.model.metadata.blocked))
            }
        }
        if(gamePage.diplomacyTab.visible){
            // gamePage.diplomacyTab.render();
            buyable = buyable.concat(gamePage.diplomacyTab.racePanels.map(rp => rp.embassyButton).filter(b => b.model.visible && isFeasible(b) == feasible));
        }
        if(gamePage.religionTab.visible){
            // gamePage.religionTab.render();
            buyable = buyable.concat(gamePage.religionTab.rUpgradeButtons.filter(btn => btn.model.visible && isFeasible(btn) == feasible && !(btn.model.metadata.noStackable && btn.model.metadata.val != 0 )));
            if(game.bld.get("ziggurat").val > 0){
                buyable = buyable.concat(gamePage.religionTab.zgUpgradeButtons.filter(zu => zu.model.visible && isFeasible(zu) == feasible))
            }

            //gamePage.religionTab.zgUpgradeButtons

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
        factoryAutomation: 0.1,
        advancedAutomation: 0.1,
        pneumaticPress: 0.1,
        barges: 0.2,
        // Factories are heckin expensive.
        carbonSequestration: 1,
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
        // Script spends a lot of time with capped pop buildings, republic is *probably* better.
        // authocracy: 0.9,

        // Faith
        templars: 1,
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

        // General advice is to build these often, crafting is v. important
        workshop: 3,
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
        smelter: 1.5,
        unicornPasture: 0.5
    };

    function isPolicy(btn){
        const btnId = (typeof btn == 'object') ? buttonId(btn) : btn;
        return game.science.policies.find(p => p.name == btnId)
    }

    function buttonUtility(btn, outOfReach = null){
        var id = buttonId(btn)
        // Faith upgrades are pretty important, as are science and workshop.
        // Incentivise them as they tend to look expensive to the optimiser.
        var mappedUtility = baseUtilityMap[id];
        var utility = mappedUtility || baseUtility;
        if(isFaithButton(btn))
            utility = mappedUtility || faithUtility;
        else if(isScienceButton(btn))
            utility = mappedUtility || scienceUtility;
        else if(isWorkshopButton(btn))
            utility = mappedUtility || workshopUtility;
        else if (isPolicy(btn))
            utility = mappedUtility || policyUtility;
        // Embassies have diminishing returns.
        else if(btn.race){
            // TODO: Should Embassy returns be based somewhat on unlocks?
            var baseutility = mappedUtility || embassyUtility;
            buyableLog.log("%s: Embassy base utility %f", id, baseutility.toFixed(2));
            const builtAlready = btn.model.metadata.val;        
            if(btn.race.sells.find(s => s.minLevel && s.minLevel > builtAlready)){            
                baseutility *= 1.6;
                buyableLog.log("%s: Bonus applied for unlocking goods %f", id, baseutility.toFixed(2));
            }
            if(diminishingReturns){
                utility = baseutility - (diminishingReturns ? game.getLimitedDR(builtAlready, baseutility) : 0);
                buyableLog.log("%s: Penalty for diminishing returns applied %f", id, utility.toFixed(2));
            } else {
                utility = baseutility;
            }
        }
        else if(isBuilding(id)) {
            var baseutility = mappedUtility || bldUtility;
            if(id == "steamworks"){
                if(game.bld.get("magneto").val > 0){
                    baseutility = 1.2 
                    buyableLog.log("%s: Steamworks specific logic (post magneto) baseutility: %f", id, baseutility.toFixed(2));
                } else if (game.workshop.get("printingPress").researched) {
                    baseUtility = 0.8
                    buyableLog.log("%s: Steamworks specific logic (post printingPress) baseutility: %f", id, baseutility.toFixed(2));
                } else {
                    baseutility = 0.2;
                    buyableLog.log("%s: Steamworks specific logic (naked) baseutility: %f", id, baseutility.toFixed(2));
                }
            }
            if((id == "mine" || id == "workshop" || id == "library" || id == "temple") && btn.model.metadata.val == 0){
                // Incentive for unlock chain Mine => Miner => Workshop & anything to do with minerals i.e. most of the game
                baseutility *= 2.5;
                buyableLog.log("%s: Incentive applied for first building %f", id, baseutility.toFixed(2));
            }
            buyableLog.log("%s: Base utility: %f", id, baseutility.toFixed(2));
            if (id == "oilWell") {
                //logger.log(id);
                var oil = game.resPool.get("oil");
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
                utility = baseutility - game.getLimitedDR(builtAlready, baseutility);
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
            var res = game.resPool.get(resName);
            if(res.value < res.maxValue)
                return false;
        }
        return true;    
    }

    function utilityForSorageCap(id, outOfReach, effects){
        var utility = 0;
        for(var infeasible of outOfReach){
            for(var price of infeasible.model.prices){
                const resource = game.resPool.get(price.name);
                if( resource.maxValue < price.val ){
                    const extraCap = price.val - resource.maxValue;
                    const currentRatioEffect = 1 + game.getEffect(resource.name + "MaxRatio");
                    var capIncrease = (effects[resource.name + "Max"] || 0) * currentRatioEffect;
                    capIncrease *= 1 + game.prestige.getParagonStorageRatio();
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
                buyableLog.info('Buying ' + label);
                game.msg('9Souls: Buying ' + buttonLabel(buyButton));
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
        var farmerJob = gamePage.village.getJob('farmer');
        if(!farmerJob.unlocked)
            return 0; // Can't reserver a farmer if it's not unlocked.
        var nipRes = gamePage.resPool.get('catnip');
        var projectedNip = projectResourceAmount(nipRes);
        var desiredEmergencyStash = reservedNipAmount();
        var desiredAdditionalNip = desiredEmergencyStash - projectedNip;
        if(desiredAdditionalNip <= 0)
            return 0; // No extra nip needed.
        var nipPerFarmer = resoucePerTick(nipRes, 1, farmerJob);
        var desiredAdditionalNipPerTick = desiredAdditionalNip / (planHorizonSeconds() * gamePage.ticksPerSecond);
        var desiredReservedFarmers = desiredAdditionalNipPerTick / nipPerFarmer;
        var reservedFarmers = Math.min(gamePage.resPool.get('kittens').value, Math.ceil(desiredReservedFarmers));
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
        if(!gamePage.villageTab.visible)
            return []
        return game.village.jobs.filter(j => j.unlocked);
    }

    function variableFromJobAssignment(j) {
        var jv = {
            name: "Job|" + buttonId(j),
            kittens: 1
        };
        for(var mod in j.modifiers){        
            var jobProduction = resoucePerTick(gamePage.resPool.resourceMap[mod], 1, j);
            jv[mod] = -1 * jobProduction * planHorizonSeconds() * game.ticksPerSecond
        }
        // Little jack to incentivise unlocking workshop
        if(j.name == "miner" && !gamePage.bld.get("workshop").unlocked){
            jv.utility = 1;
        }
        else if (j.name == "priest"){
            if(!gamePage.religionTab.visible){
                // Yeah - we should unlock that ;-)
                jv.utility = 1;
            }
        }
        return jv;
    }

    function variableForFestival(){
        if(!game.science.get("drama").researched)
            return null;
        if(game.calendar.festivalDays > (100 - gamePage.calendar.day))
            return null;
        var doFest = game.villageTab.festivalBtn;
        return {
            name: "Festival",
            manpower: 1500,
            culture: 5000,
            parchment: 2500,
            utility: happinessUtility * 3
        };
    }

    function executeFestival(){
        var numPlanned = Math.floor(plan.Festival || 0);
        if(!numPlanned)
            return;
        var numPerformed = (executedPlan.Festival || 0);
        if(numPerformed > 0)
            return;
        var doFest = game.villageTab.festivalBtn;
        if(canAffordNow(doFest)){
            execLog.log("P A R T Y Wooop Woop!");
            doFest.click();
            executedPlan.Festival = 1;
        }
    }

    function jobResourcesMaxed(job){
        for(var modifier in job.modifiers){
            var modifiedResource = game.resPool.get(modifier);
            if(modifiedResource.value < modifiedResource.maxValue)
                return false;
        }
        return true;
    }

    function normalizeAssignments(){
        // TODO: Emergency farming if catnip < reservedAmount & gain per sec < 0
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
            if(jobResourcesMaxed(j) && intPlanned){
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
            var validPlanned = 0
            for(var jobName in assignments){
                validPlanned += 
                    invalidJobs.find(ij => jobName == ij) ? 
                        0 : 
                        planned[jobName];
                    jobLog.log("%s: validPlanned %f",jobName, validPlanned.toFixed(2));
            }
            for(var jobName in assignments){
                if(validPlanned){
                    resassignProbs[jobName] = 
                        invalidJobs.find(ij => jobName == ij) ? 
                            0 : planned[jobName] / validPlanned 
                }
                else {
                    resassignProbs[jobName] = 1 / jobs.length;
                }                        
            }
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
            var validPartials = 0
            for(var jobName in assignments){
                validPartials += 
                    invalidJobs.find(ij => jobName == ij) ? 
                        0 : 
                        partials[jobName];
                    jobLog.log("%s: validPlanned %f",jobName, validPartials.toFixed(2));
            }
    
            for(var j of jobs){
                resassignProbs[j.name] = partials[j.name] / validPartials;
            }

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
        if(totalAssigned != game.resPool.get("kittens").value)
            jobLog.warn("assigned %i kittens (should have been %i)", totalAssigned, game.resPool.get("kittens").value);

        jobLog.log("normalise complete", assignments);
        return assignments;
    }

    var reassignments = 0;
    function assignJobs(){
        var assignments = normalizeAssignments();
        //jobLog.log(jobNumbers)
        for(var jobName in assignments) {
            var numPlanned = assignments[jobName];
            var j = game.village.getJob(jobName)
            //jobLog.log("Planned to assign ", numPlanned, " for job ", j.name, " currently job has ", j.value, " kittens assigned")
            if(j.value > numPlanned){
                var numToRemove = j.value - numPlanned;
                // A reassignment is moving a kitten from one job to another.
                reassignments += numToRemove;
                jobLog.log("Need to remove %i kittens from job %s (assigned %i, planned %i)", numToRemove, jobName, j.value, numPlanned);
                var jobBtn = gamePage.villageTab.buttons.find(b => b.opts.job == j.name);
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
            var j = game.village.getJob(jobName)
            if(j.value < numPlanned){
                var jobBtn = gamePage.villageTab.buttons.find(b => b.opts.job == j.name);
                var numToAdd = numPlanned - j.value;
                jobLog.log("Need to add %i kittens to job %s (assigned %i, planned %i)", numToAdd, jobName, j.value, numPlanned);
                if(numToAdd == gamePage.village.getFreeKittens()){
                    //jobLog.debug("Adding all free kittens to job ", j.name);
                    jobBtn.assignLinks.assignall.link.click();
                    return;
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
        if(game.villageTab.optimizeJobsBtn && game.villageTab.optimizeJobsBtn.model.visible){
            if(reassignments > reassignmentsBeforeOptimise * game.village.getKittens()){
                jobLog.log("optimise triggered %i > %f (%f * %i)", reassignments, (reassignmentsBeforeOptimise * game.village.getKittens()).toFixed(1), reassignmentsBeforeOptimise, game.village.getKittens());
                reassignments = 0;
                game.villageTab.optimizeJobsBtn.buttonContent.click();
            }
        }
    }

    //#endregion

    //#region Trades
    function getTradeableRaces() {
        return gamePage.diplomacy.races.filter(r => r.unlocked);
    }

    function variableFromTrade(tradeRace, outOfReach) {
        // TODO: Pretty sure I'm not doing tradeRatio correctly - is there a better way to simulate this as with production
        // diplomacy.tradeImpl, but without side effects?
        tv = {
            name: "Trade|" + buttonId(tradeRace),
            manpower: 50,
            gold: 15,
            blueprint: -0.1
        };
        for(res of tradeRace.buys){
            tv[res.name] = res.val;
        }
        var bonusForLeaderSwitch = tradeBonusForLeaderSwitch();
        var standingRatio = game.getEffect("standingRatio") + game.diplomacy.calculateStandingFromPolicies(tradeRace.name, game);
        var failureChance = tradeRace.standing < 0 ? -(tradeRace.standing + standingRatio) / 2 : 0;
        var bonusTradeChance = tradeRace.standing > 0 ? tradeRace.standing + standingRatio / 2 : 0;
        var tradeRatio = 1 + bonusForLeaderSwitch + game.diplomacy.getTradeRatio() + game.diplomacy.calculateTradeBonusFromPolicies(tradeRace.name, game) + game.challenges.getChallenge("pacifism").getTradeBonusEffect(game);
        var raceRatio = 1 + tradeRace.energy * 0.02;
        var currentSeason = game.calendar.getCurSeason().name;
        var embassyEffect = game.ironWill ? 0.0025 : 0.01;
        
        var tradeUtility = 0;
        for(sellResource of tradeRace.sells){
            //console.debug(res, tradeRace, res.minLevel, tradeRace.embassyLevel)
            // Mostly cribbed from diplomacy.tradeImpl
            if (!game.diplomacy.isValidTrade(sellResource, tradeRace)) {
                continue;
            }
            var tradeChance = sellResource.chance *
                (1 + (
                    tradeRace.embassyPrices ?
                    game.getLimitedDR(tradeRace.embassyLevel * embassyEffect, 0.75) :
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
            //console.debug(sellResource.value, failureChance, bonusTradeChance, tradeChance, tradeRatio, raceRatio, resourceSeasonTradeRatio)
            //console.debug(expected)

            /*We can't actually store more than our Max amount. I'm looking at you Sharks...
    \.          |\
    \`.___---~~  ~~~--_
    //~~----___  (_o_-~
    '           |/'
            */
            sellResource = game.resPool.get(sellResource.name);
            reserved = sellResource.name == "catnip" ? reservedNipAmount() : 0;
            if(sellResource.maxValue)
                expected = Math.min(expected, sellResource.maxValue - reserved);


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

        tv.spice = -0.35 * (1 + (tradeRace.embassyPrices ?  tradeRace.embassyLevel * embassyEffect : 0))
        //-------------- 15% + 0.35% chance per ship to get titanium ---------------
        if (tradeRace.name == "zebras") {
            var shipAmount = game.resPool.get("ship").value;
            var zebraRelationModifierTitanium = game.getEffect("zebraRelationModifier") * game.bld.getBuildingExt("tradepost").meta.effects["tradeRatio"];
            tv.titanium = -(1.5 + shipAmount * 0.03) * (1 + zebraRelationModifierTitanium) * ((0.15 + shipAmount * 0.0035) / 2);
        }

        // Trades can generate Spice, which is a luxury. Grant some utility for that if we are below some threshold.
        var spiceRes = game.resPool.get("spice");
        var spiceCons = resoucePerTick(spiceRes);
        if(projectResourceAmount(spiceRes) < -1 * spiceCons * game.ticksPerSecond * planHorizonSeconds()){
            tradeUtility += happinessUtility;
        }
        if(tradeUtility)
            tv.utility = tradeUtility;
        return tv;
    }

    function executeTrades(){
        // TODO: shuffle trades so we don't always prioritise Griffins.
        for(tradeable in plan) {
            if(!tradeable.startsWith("Trade"))
                continue;
            desiredTrades = (plan[tradeable] || 0);
            executedTrades = (executedPlan[tradeable] || 0);
            desiredRemainingTrades = desiredTrades - executedTrades;
            if(desiredRemainingTrades < 1)
                continue;
            raceName = tradeable.slice(6);
            tradeBtn = gamePage.diplomacyTab.racePanels.find(rp => rp.race.name == raceName).tradeBtn
            tradesPossibleNow = Math.floor(canAffordHowManyNow(tradeBtn));
            if(tradesPossibleNow < 1)
                continue;
            tradesToPerform = Math.min(desiredRemainingTrades, tradesPossibleNow)
            if(tradesToPerform <= 0)
                continue;
            var prevLeader = doLeaderChangeTrait("merchant");
            for(tn = 0; tn < tradesToPerform; tn++){
                // Good to free up capacity (looking at you sharks)
                executeCrafts();
                tradeBtn.buttonContent.click()
            }
            executeCrafts();
            executedPlan[tradeable] = executedTrades + tradesToPerform
            changeLeader(prevLeader);
        }
    }

    //#endregion

    //#region Crafts

    function getCrafts(){
        if(gamePage.workshopTab.visible)
            return gamePage.workshopTab.craftBtns.filter(b => b.model.visible && isFeasible(b));
        else
            return [gamePage.bldTab.children.find(btn => btn.model.name == "Refine catnip")];
    }

    function variableFromCraft(c, outOfReach){
        craft = c.craftName || 'wood'
        cv = {
            name: "Craft|" + craft
        };
        var craftAmt = (1 + game.getResCraftRatio(craft) + craftBonusForLeaderSwitch(craft) - currentLeaderCraftBonus(craft))
        craftLog.log(craft + " craftAmt " + craftAmt)
        cv[craft] = -craftAmt;
        var craftPrices = game.workshop.getCraftPrice(c.model);
        for(price of craftPrices){
            cv[price.name] = price.val;
        }
        if(craft == "wood" && game.bld.buildingsData.find(b => b.name == 'hut').val < 1){
            // We don't even have a hut yet, how quaint, we should do a little refining
            cv.utility = 1
            craftLog.log("wood craft utility: " + cv.utility)
        }
        // Mild bonus for unlock ziggurat
        else if(craft == "megalith" || craft == "scaffold"){ 
            if(!game.bld.get("ziggurat").unlocked && game.resPool.get(craft).value == 0){
                cv.utility = 0.4;
                craftLog.log(craft + " craft utility: " + cv.utility)
            }
        }
        // Ships are good, up to a point ;-)
        else if(craft == "ship"){
            const maxShips = 5000;
            const fractionofShipsPerUtility = 0.15;
            const builtAlready = game.resPool.get("ship").value;
            if(builtAlready == 0) {
                cv.utility = 5;
                craftLog.log("Initial ship craft utility: " + cv.utility)
            } else if(builtAlready < maxShips){
                const shipsPerUtility = builtAlready * fractionofShipsPerUtility;
                const utilityPerCraft = craftAmt / shipsPerUtility;
                cv.utility = utilityPerCraft;
                craftLog.log("ship craft utility: " + cv.utility)
            }
            const cargoShips = game.workshop.get("cargoShips");
            if(cargoShips.researched){
                // Buildings.js line ~850
                //100% to 225% with slow falldown on the 75%
                var limit = 2.25 + game.getEffect("shipLimit") * game.bld.get("reactor").on;
                var ratioNow = 1 + game.getLimitedDR(cargoShips.effects["harborRatio"] * builtAlready, limit);
                var ratioAfterCraft = 1 + game.getLimitedDR(cargoShips.effects["harborRatio"] * (builtAlready + craftAmt), limit);
                var ratioChange = ratioAfterCraft - ratioNow;

                var shipStorageUtility = utilityForSorageCap("ship", outOfReach, {
                    catnipMax: (2500 * ratioChange), woodMax: (700 * ratioChange), mineralsMax: (950 * ratioChange), coalMax: (100 * ratioChange), ironMax: (150 * ratioChange), titaniumMax: (50 * ratioChange), goldMax: (25 * ratioChange)
                }
                );
                cv.utility += shipStorageUtility;
                craftLog.log("ship utility for storage: " + shipStorageUtility + " total ship craft utility" + cv.utility )
            }
        } 
        // Manuscript max culture bonus (and may incentivize early temple)
        else if (craft == "manuscript") {
            cv.utility = manuscriptUtility(outOfReach) * craftAmt;
            craftLog.log("manuscript craft utility: " + cv.utility)
            if(!game.resPool.get(craft).value){
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
        var scienceMaxCap = game.bld.getEffect("scienceMax");
        scienceMaxCap += game.getEffect("pyramidSpaceCompendiumRatio") * game.space.getEffect("scienceMax"); //lets treat trasnfered science max from space same way
        if (game.ironWill) {
            scienceMaxCap *= 10;
        }
        if (game.prestige.getPerk("codexLeviathanianus").researched) {
            var blackLibrary = game.religion.getTU("blackLibrary");
            var ttBoostRatio = 1 + blackLibrary.val * (blackLibrary.effects["compendiaTTBoostRatio"] + game.getEffect("blackLibraryBonus"));
            scienceMaxCap *= 1 + 0.05 * ttBoostRatio * this.game.religion.transcendenceTier;
        }
        scienceMaxCap += game.bld.getEffect("scienceMaxCompendia");
        var compendiaScienceMax = Math.floor(this.game.resPool.get("compedium").value * 10);

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
            var cultureBonusRaw = Math.floor(game.resPool.get("manuscript").value);
            var additionalMaxCultureFromManuscript = game.getUnlimitedDR(cultureBonusRaw + 1, 0.01) - game.getUnlimitedDR(cultureBonusRaw, 0.01);
            additionalMaxCultureFromManuscript *= 1 + game.getEffect("cultureFromManuscripts");
            var utility = utilityForSorageCap("manuscript", outOfReach, {cultureMax: additionalMaxCultureFromManuscript});
            craftLog.log("additionalMaxCultureFromManuscript %f, utility %f", additionalMaxCultureFromManuscript.toFixed(1), utility.toFixed(4));
            return utility;
    }

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
            executedPlan[craftable] = alreadyDone + numToActuallyCraft;
            game.workshop.craft(craftName, numToActuallyCraft)
        }
    }

    //#endregion

    //#region Explore

    function canUnlockRace(){
        // See diplomacy.js unlockRandomRace, ~ln 270
        // Is any of the "low requirement" 3 still locked
        if(gamePage.diplomacy.races.slice(0, 3).find(r => !r.unlocked))
            return true;
        var nagas = gamePage.diplomacy.get("nagas");
        if (!nagas.unlocked && game.resPool.get("culture").value >= 1500){
            return true;
        }
        var zebras = gamePage.diplomacy.get("zebras");
        if (!zebras.unlocked && game.resPool.get("ship").value >= 1){
            return true;
        }
        var spiders = gamePage.diplomacy.get("spiders");
        if (!spiders.unlocked && game.resPool.get("ship").value >= 100 && game.resPool.get("science").maxValue > 125000){
            return true;
        }
        var dragons = gamePage.diplomacy.get("dragons");
        if (!dragons.unlocked && game.science.get("nuclearFission").researched){
            return true;
        }
        return false;
    }

    function variableFromExplore() {
        gamePage.diplomacyTab.render();
        if(!gamePage.diplomacyTab.visible)
            return null;
        if(!isFeasible(gamePage.diplomacyTab.exploreBtn)) 
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
        if(!gamePage.diplomacyTab.visible)
            return null;
        desiredExplore = (plan["Explore"] || 0);
        if(desiredExplore < 1)
            return;

        var btn = gamePage.diplomacyTab.exploreBtn
        if(canAffordNow(gamePage.diplomacyTab.exploreBtn)){
            game.msg('9Souls: To seek out new life and new civilizations...');
            btn.buttonContent.click();        
            executedPlan.Explore = 1;        
            jobLog.log("Replanning (explored)");
            planNow();
        }
    }

    //#endregion

    //#region Hunts

    function variableFromHunt(){
        if(!gamePage.villageTab.visible || !gamePage.villageTab.huntBtn.model.visible)
            return [];
        hunterRatio = game.getEffect("hunterRatio") + game.village.getEffectLeader("manager", 0);
        ivoryProb = (0.45 + 0.02 * hunterRatio) / 2;
        averageIvory = ivoryProb * (50 + (40 * hunterRatio));
        averageFurs = (80 + (65 * hunterRatio)) / 2;
        
        // There is some utility to having a few luxury resources floating about (about a season's worth buffer?).
        furRes = game.resPool.get('furs');
        ivoryRes = game.resPool.get('ivory');
        furCons = resoucePerTick(furRes, 0, null);
        ivoryCons = resoucePerTick(ivoryRes, 0, null);

        utilityForLux = 0
        var furDesiredToBuffer = -1 * furCons * game.ticksPerSecond * planHorizonSeconds() - projectResourceAmount(furRes);
        var huntsToFillFurBuffer = furDesiredToBuffer / averageFurs; 
        if(furDesiredToBuffer > 0){
            utilityForLux += happinessUtility;
        }
        var ivoryDesiredToBuffer = -1 * ivoryCons * game.ticksPerSecond * planHorizonSeconds() - projectResourceAmount(ivoryRes);
        var huntsToFillIvoryBuffer = ivoryDesiredToBuffer / averageIvory;
        if(ivoryDesiredToBuffer > 0){
            utilityForLux += happinessUtility;
        }
        // Sooo sparkly.
        unicornResource = game.resPool.get('unicorns');
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
        if(!gamePage.villageTab.visible || !gamePage.villageTab.huntBtn.model.visible)
            return;
        desiredHunts = Math.ceil((plan["Hunt|ForResources"] || 0) + (plan["Hunt|ForLuxury"] || 0));
        executedHunts = executedPlan["Hunt"] || 0;
        desiredRemainingHunts = desiredHunts - executedHunts;
        if(desiredRemainingHunts < 1)
            return;
        possibleHuntsNow = Math.floor(game.resPool.get("manpower").value / 100);
        if(possibleHuntsNow < 1)
            return;
        huntsToPerform = Math.min(desiredRemainingHunts, possibleHuntsNow)
        craftLog.log("Hunting ", huntsToPerform, huntsToPerform == possibleHuntsNow ? "  (as many as possible)" : ""," times (", executedHunts + huntsToPerform, "/", desiredHunts ,")")
        if(huntsToPerform == possibleHuntsNow){
            gamePage.village.huntAll()
        } else {
            for(i = 0; i < huntsToPerform; i++){
                gamePage.villageTab.huntBtn.buttonContent.click()
            }
        }
        executeCrafts();
        executedPlan["Hunt"] = executedHunts + huntsToPerform;
    }

    //#endregion

    //#region Incrementable Building

    function getToggleableBuildings(){
        return gamePage.bld.buildingsData.filter(function(b){return b.val > 0 && b.togglableOnOff; });
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

            const magneto = game.bld.get("magneto");
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

            var coalRes = game.resPool.get("coal");
            var coalNoSteam = resoucePerTick(coalRes, 0);
            var coalWithSteam = resoucePerTick(coalRes, 3, bld);
            var coalPerTickDiff = coalNoSteam - coalWithSteam;
            bv.coal = coalPerTickDiff * game.ticksPerSecond * planHorizonSeconds();

            if(effects.manuscriptPerTickProd){
                bv.manuscript = -1 * effects.manuscriptPerTickProd * game.ticksPerSecond * planHorizonSeconds() * bld.val;
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
                var btn = gamePage.bldTab.children.find(btn => buttonId(btn) == bldId);
                btn.toggle.link.click();
            }
        }
    }

    function getIncrementableBuildings(){
        return gamePage.bld.buildingsData.filter(b => b.val > 0 && b.togglable);
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
            else if (effect == "magnetoRatio") {
                bv.utility = globalProductionUtility * 100 * effects[effect];
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
            var res = game.resPool.get(resName);
            //console.log(res)
            if(!res){
                buyableLog.warn(bld, " is claiming to make a resource ", resName, " I can't find ", bld)
                continue;
            }
            resRate = resoucePerTick(res, 2, bld);
            bv[resName] = -resRate * game.ticksPerSecond * planHorizonSeconds();
        }

        // Breweries should be off except during festivals.
        if(bldId == "brewery"){
            if(game.calendar.festivalDays > 0){
                // Valueing happiness at ~0.2 per 10% currently.
                bv.utility = happinessUtility * 3 / 100;
            } else {
                bv.utility = -0.01;
            }
        }

        // TODO: Pollution
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
            var bldBtn = gamePage.bldTab.children.find(btn => btn.opts.building == toggleableBld.name)
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
    function resoucePerTick(res, mode = 0, modeVariable = null) {
        simLog.log("resoucePerTick(%s, %i, %s)", res.name, mode, buttonId(modeVariable))
        var productionStack = game.getResourcePerTickStack(res.name, false, game.calendar.season);
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
        var res = game.resPool.get(resName);
        modeVar = null;
        switch(mode){
            case 1:
                modeVar = getJobAssignments().find(ja => ja.name == modeVarName);
                break;
            case 2:
            case 3:
                modeVar = gamePage.bld.get(modeVarName);
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
                simLog.log("village logic, mode ", mode)
                if(mode == 1){
                    simLog.log("adding one villager of production", modeVariable.modifiers, modeVariable.modifiers[resource.name])
                    prod += (modeVariable.modifiers[resource.name] || 0) * gamePage.village.happiness
                } else {
                    simLog.log("ignoring village production")
                    continue;
                }
            }
            else if (resourceModifier.name == "Production" && lastMod == null) {
                switch(mode){
                    case 1:
                        simLog.log("ignoring fixed production")
                        break;
                    case 0:
                    case 3:
                        prod += resourceModifier.value;
                        break;
                    case 2:
                        prod += effects[resource.name + "PerTickBase"] || 0;
                }
            }
            else if (resourceModifier.name == 'Conversion Production' && lastMod == null){
                if(mode == 2) {
                    prod += (effects[resource.name + "PerTickAutoprod"] || 0);
                } else {            
                    continue;
                }
            }
            else if(resourceModifier.name == "Without Improvement" && lastMod == null){
                if(mode == 2){
                    prod += (effects[resource.name + "PerTick"] || 0)
                } else {
                    continue;
                }
            }
            else if (resourceModifier.name == 'Conversion Production' && lastMod != null){
                if(mode == 3) {
                    prod += (effects[resource.name + "PerTickProd"] || 0) * modeVariable.val;
                } else {
                    continue;
                }
            }
            else if (resourceModifier.name == 'Conversion Consumption'){
                if(mode == 2){
                    prod += (effects[resource.name + "PerTickCon"] || 0);
                } else {
                    continue;
                }
            }
            else if (resourceModifier.name == 'Steamworks' && mode != 3){
                continue;
            }
            // else if (resourceModifier.name == 'Magnetos'){
            //     var magRatio = 1 + game.getEffect("magnetoRatio");
            //     if(mode == 3){
            //         var swRatio = (1 + modeVariable.effects["magnetoBoostRatio"] * modeVariable.val);
            //         magRatio *= swRatio
            //     }
            //     prod *= magRatio;
            // }
            else if (resourceModifier.type == 'fixed') {
                if(mode == 0 || mode == 3)
                    prod += resourceModifier.value;
                else 
                    continue;
            }
            else if (resourceModifier.type == 'ratio')
                prod *= 1 + resourceModifier.value;
            //else
            //    console.warn("Didn't know how to include calculation of ", resourceModifier, " in evaluateProductionStackNonVariable.");
            lastMod = resourceModifier
        }
        return prod;
    }

    function projectResourceAmount(res) {
        var baseProduction = resoucePerTick(res, 0, null);
        var projected = res.value + (baseProduction * gamePage.ticksPerSecond * planHorizonSeconds());
        var timeRatioBonus = 1 + game.getEffect("timeRatio") * 0.25;
        var chanceRatio = (game.prestige.getPerk("chronomancy").researched ? 1.1 : 1) * timeRatioBonus;
        if(res.name == "science"){
            // Astro events.
            var eventChance = (0.0025 + game.getEffect("starEventChance")) * chanceRatio;
            if (this.game.prestige.getPerk("astromancy").researched) {
                eventChance *= 2;
            }
            // Evaluated once per day.
            var astroEventsExpected = eventChance * planHorizonSeconds() / 2;
            var celestialBonus = game.workshop.get("celestialMechanics").researched
                ? (game.ironWill ? 1.6 : 1.2)
                : 1;
            var sciBonus = 25 * celestialBonus * (1 + this.game.getEffect("scienceRatio"));
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
        var nipDemandRatio = 1 + gamePage.globalEffectsCached.catnipDemandRatio;
        var ktns = gamePage.resPool.resourceMap["kittens"].value ;
        return ktns * nipDemandRatio * gamePage.village.happiness * 4 * reservedNipDays 
    }

    //#endregion

    //#region Include External Libraries

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

    function includeLoglevel() {
        if (typeof woodman !== 'undefined') {
            logger.log("woodman already included");
            return;
        }
        var xhttp = new XMLHttpRequest();
        xhttp.onreadystatechange = function() {
            if (this.readyState == 4 && this.status == 200) {
            eval(xhttp.responseText);
            // TODO: This line doesn't actually init the logger. woodman.load('console') needs to be called manually :-(
            woodman.load('console');
            window.logger = woodman.getLogger('main');
            logger.level = "info";
            window.leaderLog = woodman.getLogger("main.Leader");
            leaderLog.level = "info";
            window.faithLog = woodman.getLogger("main.faith");
            faithLog.level = "info";
            window.execLog = woodman.getLogger("main.Execution");
            execLog.level = "info";
            window.buyableLog = woodman.getLogger("main.buyable");
            buyableLog.level = "info";
            window.jobLog = woodman.getLogger("main.Jobs");
            jobLog.level = "info";
            window.craftLog = woodman.getLogger("main.Craft");
            craftLog.level = "info";
            window.simLog = woodman.getLogger("main.Simulate");
            simLog.level = "info";

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
        return !game.science.get("civil").researched;
    }

    function kittenWithTrait(desiredTrait){
        if(civilServiceNotResearched())
            return null;
        var candidates = game.village.sim.kittens.filter(k => k.trait && k.trait.name == desiredTrait);
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
        var previousLeader = game.village.leader
        changeLeader(kittenWithTrait(desiredTrait));
        return previousLeader;
    }

    function changeLeader(kitten){
        if(civilServiceNotResearched())
            return;
        if(!kitten)
            return;
        if(game.village.leader == kitten)
            return;
        //console.debug("Chaging leader to ", kitten.name, " ", kitten.surname, " (rank ", kitten.rank, kitten.trait ? kitten.trait.name : "", ")")
        game.villageTab.censusPanel.census.makeLeader(kitten);
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
        if(!game.village.leader)
            return 0;
        if(!game.village.leader.trait)
            return 0;
        for(desiredEffect of leaderDesiredTraitsFromCraft(craftName)){
            if(game.village.leader.trait.name == desiredEffect.trait)
                return desiredEffect.bonus;
        }
        return 0;
    }

    function tradeBonusForLeaderSwitch(){
        if(civilServiceNotResearched())
            return 0;
        if(game.village.leader && game.village.leader.trait && game.village.leader.trait.name == "merchant")
            return 0;
        var burnedParagonRatio = 1 + game.prestige.getBurnedParagonRatio();
        var leaderRatio = 1;
        if (game.science.getPolicy("monarchy").researched){
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
            if(game.village.leader && game.village.leader.trait && game.village.leader.trait.name == desiredTrait.trait){
                //console.debug("Leader already has trait", desiredTrait.trait);
                return null;
            }
            var newLeader = kittenWithTrait(desiredTrait.trait)
            if(newLeader){
                prevLeader = game.village.leader;
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
        var burnedParagonRatio = 1 + game.prestige.getBurnedParagonRatio();
        var leaderRatio = 1;
        if (game.science.getPolicy("monarchy").researched){
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
                var craftableResource = game.resPool.get(craftName);
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
        return game.village.sim.kittens.reduce(fnRankBy);
    }

    function variableForPromoteLeader(){
        if(civilServiceNotResearched())
            return null;
        var highRank = kittenForPromotion();
        var expToPromote = game.village.sim.expToPromote(highRank.rank, highRank.rank + 1, highRank.exp)
        // Not much we can do about a lack of experience.
        if(!expToPromote[0])
            return null;
        // We just need to find out how much, hence assume infinite resource.
        var goldToPromote = game.village.sim.goldToPromote(highRank.rank, highRank.rank + 1, Infinity)
        return {
            name: "PromoteLeader",
            gold: goldToPromote[1],
            utility: 2
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
        var expToPromote = game.village.sim.expToPromote(highRank.rank, highRank.rank + 1, highRank.exp);
        var goldToPromote = game.village.sim.goldToPromote(highRank.rank, highRank.rank + 1, game.resPool.get("gold").value);
        if (expToPromote[0] && goldToPromote[0]) {
            execLog.info("Congrats to %s %s who was promoted from rank %i to %i", highRank.name, highRank.surname, highRank.rank, highRank.rank + 1)
            game.village.sim.promote(highRank);
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

    function desiredTraitToBuy(btn){
        if(btn.model.prices.find(p => p.name == "faith"))
            return "wise";
        else if (btn.tab && (btn.tab.tabId == "Science" || btn.tab.tabId == "Workshop"))
            return "scientist";
        return null;
    }

    function canSwapLeaderToPurchase(btn, feasibilityStudy = true){
        var limitingFactors = limitedResources(btn);
        if(limitingFactors.length == 0)
            return null;
        // Religion Upgrade
        var burnedParagonRatio = 1 + game.prestige.getBurnedParagonRatio();
        var leaderRatio = 1;
        if (game.science.getPolicy("monarchy").researched){
            leaderRatio = 1.95;
        }
        if(btn.model.prices.find(p => p.name == "faith")){
            // Current leader is already wise. swapping doesn't help.
            if(game.village.leader && game.village.leader.trait && game.village.leader.trait.name == "wise")
                return null;    
            // No wise kitten to swap to.
            if(!kittenWithTrait("wise"))
                return null;
            var reductionRatio = game.getLimitedDR((0.09 + 0.01 * burnedParagonRatio) * leaderRatio, 1.0); 
            for(var factor of limitingFactors){
                // Wisdom only helps with faith and gold.
                if(! (factor.name == "faith" || factor.name == "gold")){
                    //leaderLog.log("needs non faith / gold resource");
                    return null;
                }
                var limRes = game.resPool.get(factor.name);
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
            if(game.village.leader && game.village.leader.trait && game.village.leader.trait.name == "scientist")
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
            var limRes = game.resPool.get(factor.name);
            var resourceValue = feasibilityStudy ? limRes.maxValue : limRes.value;
            var reductionRatio = game.getLimitedDR(0.05 * burnedParagonRatio  * leaderRatio, 1.0); //5% before BP
            
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
        var burnedParagonRatio = 1 + this.game.prestige.getBurnedParagonRatio();
        var leaderRatio = 1;
        if (this.game.science.getPolicy("monarchy").researched){
            leaderRatio = 1.95;
        }
        if((isWorkshopButton(btn) || isScienceButton(btn)) && 
            resName == "science" && 
            kittenWithTrait("scientist") &&
            leaderTrait() != "scientist") {
            return 1 - (game.getLimitedDR(0.05 * burnedParagonRatio  * leaderRatio, 1.0));
        } else if(
            isFaithButton(btn) && 
            (resName == "faith" || resName == "gold") && 
            kittenWithTrait("wise") &&
            leaderTrait() != "wise") {
            return 1 - (game.getLimitedDR((0.09 + 0.01 * burnedParagonRatio) * leaderRatio, 1.0));
        } else {
            return 1;
        }
    }

    function leaderTrait(){
        if(game.village.leader && game.village.leader.trait)
            return game.village.leader.trait.name;
        return "";
    }

    //#endregion

    //#region Faith

    // TODO: Adore
    // TODO: Transcend

    function variableForAdoreGalaxy(){
        if(!gamePage.religionTab.visible ||
        !gamePage.religionTab.adoreBtn || 
        !gamePage.religionTab.adoreBtn.model.visible)
            return null;
        // Ok Adore is a valid action.
        const agVar = {
            name: "AdoreTheGalaxy"
        };
        var worship = game.religion.faith
        var ttPlus1 = (game.religion.getRU("transcendence").on ? game.religion.transcendenceTier : 0) + 1;
        var currFaithRatio = game.religion.faithRatio;
        var faithRatioIncrease = worship / 1000000 * ttPlus1 * ttPlus1 * 1.01;
        var currApocBonus = game.religion.getApocryphaBonus();
        var newApocBonus = game.getUnlimitedDR(currFaithRatio + faithRatioIncrease, 0.1) * 0.1;
        var apocBonusIncrease = newApocBonus - currApocBonus;

        var currentSolRevBonus = calculateSolarRevolutionRatio(worship);
        var currentSolRevUtility = currentSolRevBonus * 100 * globalProductionUtility;
    }

    function variableForPraiseSun(){
        if(!gamePage.religionTab.visible)
            return null;
        gamePage.religionTab.render();
        const halfFaith = game.resPool.get("faith").maxValue / 2;
        const additionalWorship = halfFaith * (1 + game.religion.getApocryphaBonus());
        // TODO: Faith is not 1-1 with worship after apocrypha / transcend etc.
        // What a crumbily named variable :-(. Hysterical raisins I suppose.
        const worship = game.religion.faith;
        const nextUnlockBtn = gamePage.religionTab.rUpgradeButtons.find(ru => !ru.model.visible);
        const revolutionBtn = gamePage.religionTab.rUpgradeButtons.find(ru => ru.id == "solarRevolution");
        // Utility for unlocking another option to work towards.
        const worshipToUnlockNextOption = nextUnlockBtn ? nextUnlockBtn.model.metadata.faith - worship: -1;
        const howFarDoesPraiseGetUs = Math.min(1, additionalWorship / worshipToUnlockNextOption);
        //TODO: Does below utility for faith unlock in variableForPraiseSun perform better (it's more consistant at least)
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
        var uncappedBonus = game.religion.getRU("solarRevolution").on ? game.getUnlimitedDR(worship, 1000) / 100 : 0;
        return game.getLimitedDR(uncappedBonus, 10 + game.getEffect("solarRevolutionLimit") + (game.challenges.getChallenge("atheism").researched ? (game.religion.transcendenceTier) : 0)) * (1 + game.getLimitedDR(game.getEffect("faithSolarRevolutionBoost"), 4));
    }

    function praiseUnderPlan(){
        if(!plan)
            return;
        var plannedPraise = Math.floor(plan["PraiseTheSun"] || 0);
        var praiseToDo = plannedPraise - (executedPlan["PraiseTheSun"] || 0);
        if(praiseToDo <= 0)
            return;
        var faithAmount = game.resPool.get("faith").value;
        var halfFaith = game.resPool.get("faith").maxValue / 2;
        var praisesAvailable = faithAmount / halfFaith;
        //console.log("praiseToDo: %i, faithAmount: %i, halfFaith: %i, praisesAvailable: %i", praiseToDo, faithAmount, halfFaith, praisesAvailable);
        if(praisesAvailable > 1){
            faithLog.info("About to paise %i ", praisesAvailable);
            gamePage.religionTab.praiseBtn.buttonContent.click();
            executedPlan.PraiseTheSun = (executedPlan.PraiseTheSun || 0) + praisesAvailable;
        }
    }

    function variableForSacrifice(){
        if(!gamePage.religionTab.visible)
            return null;
        var zigs = game.bld.get("ziggurat").val;
        if(game.bld.get("ziggurat").val == 0)
            return null;
        var su = {
            name: "SacrificeUnicorns",
            unicorns: 2500,
            tears: -zigs
        }
        // Tears are a luxury.
        if(game.resPool.get("tears").value == 0)
            su.utility = 0.1;
        return su;
    }

    function sacrificeUnderPlan(){
        if(!plan)
            return;
        if(!gamePage.religionTab.visible)
            return null;
        if(game.bld.get("ziggurat").val == 0)
            return null;
        var executedSacs = executedPlan["SacrificeUnicorns"] || 0;
        var plannedSac = Math.floor(plan["SacrificeUnicorns"] || 0);
        var sacsDesired = plannedSac - executedSacs;
        var sacsPossible = Math.floor(game.resPool.get("unicorns").value / 2500.0);
        var sacsToDo = Math.min(sacsPossible, sacsDesired)
        if(sacsToDo <= 0)
            return;
        for(var i = 0; i < sacsToDo; i++){
            faithLog.info("I will bathe in unicorn tears!");
            gamePage.religionTab.sacrificeBtn.buttonContent.click()
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
        var historyString = `${game.stats.getStatCurrent("timePlayed").val.padEnd(18)}${game.stats.getStat("totalResets").val + 1}.${game.calendar.year}`;
        historyString = historyString.padEnd(28);
        historyString += `${game.resPool.get("kittens").maxValue} kittens ${mostAdvancedResearch(game.science.techs)}, ${mostAdvancedResearch(game.workshop.upgrades)}`
//         historyString += `

// `;
//         var data = game.save();
// 		data = JSON.stringify(data);
//         var encodedData = game.compressLZData(data);
//         historyString += encodedData;
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
        var paragon = game.resPool.get("paragon").value;
        var totalParagon = paragon + game.resPool.get("burnedParagon").value;
        if(totalParagon == 0){
            // First reset after Concrete Huts is a typical kind of time.
            // Researching apocripha should also be a priority as epiphany carries over.
            if(game.workshop.get("concreteHuts").researched && game.religion.getRU("apocripha").on){
                planningForResetSince = new Date();
            }
        } else {
            // Lets try to double paragon.
            var resetParagon = game.getResetPrestige().paragonPoints;
            if(resetParagon * 2 >= totalParagon && game.religion.getRU("apocripha").on){
                planningForResetSince = new Date();
            }
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
            // TODO: Neutered this logic as it went wrong in last reset. Monitor and check.
            // Should always be true I think, but who knows - this code is hard to test ;-)
            // if(game.religionTab.adoreBtn.model.visible)
            //     game.religionTab.adoreBtn.buttonContent.click();
            // game.reset();
            return;
        }

        var diffMins = Math.floor(timeLeftSecs / 60);
        var diffSeconds = Math.floor(timeLeftSecs - (diffMins * 60));
        if(diffMins)
            diffMins += " mins"
        if(diffSeconds)
            diffSeconds = " " + diffSeconds + " seconds"
        else
            diffSeconds = ""
        execLog.warn("THE END IS NIGH. Reset incoming in approximately %s%s.", diffMins, diffSeconds);
    }

    function addMinutes(date, minutes) {
        return new Date(date.getTime() + minutes*60000);
    }

    //#endregion

    //#region Sell

    function getSellable(){
        return gamePage.bldTab.children.slice(2).filter(b => 
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
            game.msg('9Souls: Selling ' + buttonLabel(sellBtn) + "!");
            executeCrafts();
            sellBtn.sellHref.link.click();
            executedPlan["Sell|" + sellItemId] = 1;
            planNow();
        }
    }

    //#endregion

includeLoglevel();
includeSolver();
    //})();