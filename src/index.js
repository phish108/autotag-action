// import * as core from "@actions/core";
// import * as github from "@actions/github";
// import * as semver from "semver";

const core   = require("@actions/core");
const github = require("@actions/github");
const semver = require("semver");

function getParameters() {
    const retval = {};
    const Parameters = [
        "branch",
        "bump",
        "dry-run",
        "force",
        "github-token",
        "issue-labels" ,
        "release-branch",
        "style",
        "tag",
        "version-prefix",
        "with-v"
    ];

    const Styles = [
        "semver",
        "date",
        "datetime",
        "dotdate",
        "dotdatetime",
        "isodate",
        "isodatetime"
    ];

    // helper for direct value remapping
    const Remap = {
        "github-token": "token",
        "issue-labels": "labels",
        "release-branch": "releaseBranch",
        "version-prefix": "prefix"
    };

    Parameters.forEach((pname) => retval[pname] = core.getInput(pname));
    Object.keys(Remap).forEach((pname) => retval[Remap[pname]] = retval[pname]);

    // fix complex parameters
    retval["dryRun"] = retval["dry-run"].toLowerCase() !== "false";
    retval["force"] = retval["force"].toLowerCase() !== "false";
    retval["withV"]  = retval["with-v"].toLowerCase() === "false" ? "" : retval.prefix;

    retval["style"] = Styles.includes(retval["style"]) ? retval["style"] :  "semver";

    // ensure that everything is fine if the user passed an empty list
    retval.issueLabels = retval.labels.split(",").map(label => label.trim());

    if (!retval.issueLabels.length) {
        retval.issueLabels = ["enhancement"];
    }

    // set the date tag as forced tag, if set by style
    const dateTag = getDateStyle(retval.style);

    retval.tag = dateTag === "" ? retval.tag : dateTag;

    return retval;
}

function getDateStyle(style) {
    if (! style.match(/date/) ) {
        return "";
    }

    const now = new Date();

    if (style.match(/iso/)) {
        if (style.match(/datetime/)) {
            return now.toISOString().replace(/:/g,"-").replace(/-\d\d\.\d+Z$/, "");
        }

        return now.toISOString().replace(/:/g,"-").replace(/T.+$/, "");
    }

    let seperator = "";
    let date = [now.getFullYear(), now.getMonth(), now.getDay()];

    if (style.match(/dot/)) {
        seperator = ".";
    }

    if (style.match(/datetime/)) {
        date = date.concat([now.getHour(), now.getMinute()]);
    }

    return date.join(seperator);
}

async function checkTag(tagList, tagName) {
    const result = tagList.filter(tag => tag.name === tagName);

    return result.length > 0;
}

async function getAllTags(context) {
    const { data } = await context.octokit.rest.repos.listTags({
        owner: context.owner,
        repo: context.repo
    });

    const allVTags = data
        .map(tag => tag.name = semver.clean(tag.name))
        .filter(tag => tag.name !== null)
        .sort((a,b) => semver.compare(a.name, b.name));

    // FIXME: filter tags only relevant for the current branch (Issue 155)

    return allVTags;
}

function dropPreReleaseTags(tagList) {
    return tagList.filter((tag) => semver.prerelease(tag.name) === null);
}

async function loadBranch(context, branch) {
    const result = await context.octokit.rest.git.listMatchingRefs({
        owner: context.owner,
        repo: context.repo,
        ref: `heads/${branch}`
    });

    // core.info(`branch data: ${ JSON.stringify(result.data, undefined, 2) } `);
    return result.data.shift();
}

async function getIssueLabel(context, issue_number) {
    const { data } = await context.octokit.rest.issues.get({
        owner: context.owner,
        repo: context.repo,
        issue_number
    });

    return data ? data.labels : [];
}

async function messageToBumpLevel(context, message) {
    const wip   = new RegExp(/#wip\b/);
    const major = new RegExp(/#major\b/);
    const minor = new RegExp(/#minor\b/);
    const issue = new RegExp(/fix(?:es)? #(\d+)\b/);

    if (wip.test(message)) {
        // this will stop the tagging.
        return "none";
    }
    if (major.test(message)) {
        return "major";
    }
    if (minor.test(message)) {
        return "minor";
    }

    const id = issue.exec(message);

    if (id && Number(id[1]) > 0) {
        return id[1];
    }

    return "patch";
}

// tagSha refers to the previous tagged commit
async function checkMessages(parameters, context, tagSha) {
    const issueLabels = parameters.issueLabels;

    // core.info(`load commits since ${sha}`);
    const result = await context.octokit.rest.repos.listCommits({
        owner: context.owner,
        repo: context.repo,
        sha: tagSha
    });

    if (!(result && result.data)) {
        // nothing to do
        return "none";
    }

    const levels = result.data
        .map((commit) => messageToBumpLevel(commit.message));

    if (levels.includes("major")) {
        return "major";
    }
    if (levels.includes("minor")) {
        return "minor";
    }

    const testlevels = ["major", "minor", "patch"];
    const issues = levels
        .filter(bl => !testlevels.includes(bl));

    if (issues.length) {
        for (const issue of issues)  {
            const label = await getIssueLabel(context, issue);

            if (issueLabels.includes(label)) {
                core.info("found enhancement issue");
                return "minor";
            }
        }
        return "patch";
    }

    if (levels.includes("patch")) {
        return "patch";
    }

    // we found only work in progress tags
    return "none";
}

function isReleaseBranch(currentBranch, allowedBranches) {
    // this algorithm accepts a few extra iterations for the sake of simplicity
    const isReleasable = allowedBranches
        .split(",")
        .map(b => new RegExp(b.trim()).test(currentBranch))
        .filter(e => e);

    return isReleasable.length > 0; // note that more than one patter may match a specific branch.
}

async function verifyBranch(parameters, context) {

    const forcedBranch = parameters.branch && parameters.branch.length;
    const branch = forcedBranch ? parameters.branch.trim() : context.ref.replace(/refs\/heads\//, "");

    core.info(`check forced branch ${branch}`);

    const branchInfo = await loadBranch(context.octokit, context.ref, branch);

    if (!branchInfo) {
        throw new Error(`unknown ${ forcedBranch ? "forced " : "" }branch ${branch} provided`);
    }

    return branchInfo;
}

async function applyDry(context, tag) {
    core.info(`Dry run. Do not apply ${tag} to ${context.repo}`);
}

async function applyTag(context, tag) {
    if (!tag || tag === "") {
        core.info("No tag to apply");
        return;
    }

    core.info(`apply new tag ${ tag } to ${ context.repo }`);

    const ref = `refs/tags/${ tag }`;

    await context.octokit.rest.git.createRef({
        owner: context.owner,
        repo: context.repo,
        ref: ref,
        sha: context.sha
    });
}

async function checkStatic(parameters, context, tagList) {
    const newTag = parameters.tag;

    const doesTagExist = checkTag(tagList, newTag);

    if (doesTagExist) {
        core.info(`tag already exists ${newTag} in ${ context.repo }`);

        if (!parameters.force) {
            return "";
        }
    }

    return newTag;
}

async function checkSemver(parameters, context, tagList) {
    core.info(`check semver tags before ref: ${ context.sha }`);

    const latestTag = tagList.pop();
    const latestMainTag = dropPreReleaseTags(tagList).pop();

    core.info(`the previous tag of the repository ${ JSON.stringify(latestTag, undefined, 2) }`);
    core.info(`the previous main tag of the repository ${ JSON.stringify(latestMainTag, undefined, 2) }`);

    core.setOutput("tag", versionTag);

    if (latestTag && latestTag.commit.sha === context.sha) {
        core.info("no new commits, avoid tagging");
        return "";
    }

    core.info(`The repo tags: ${ JSON.stringify(latestTag, undefined, 2) }`);

    const versionTag    = latestTag && latestTag.name ? latestTag.name : "0.0.0";
    const versionSemver = semver.clean(versionTag);

    // check if commits and issues point to a diffent release level
    // This filters hash tags for major, minor, patch and wip commit messages.
    core.info("check commits in branch");

    const bumpLevel = await checkMessages(
        parameters,
        context,
        latestMainTag ? latestMainTag.commit.sha : "", // terminate at the previous tag or at the initial commit
    );

    if (bumpLevel === "none") {
        core.info("no commit messages or work in progress found, avoid tagging");
        return "";
    }

    core.info(`commit messages force bump level to ${ bumpLevel }`);

    // major changes may ooccur between prereleases. In these cases the version number of the release will change.
    let nextVersion = semver.inc(versionSemver, bumpLevel);

    if (!isReleaseBranch(context.branchName, parameters.releaseBranch)) {
        core.info(`${ context.branchName } is not a release branch, create a prelease tag`);

        // find the latest tag on the same major release
        // increase the prerelease number
        nextVersion = semver.inc(nextVersion, "prerelease", context.branchName);
    }

    core.info( `bump tag to ${ nextVersion }` );

    // finally we want too verify that the tag does not exist already
    // IMPORTANT: Dont attach the new tag to parameters.tag because of possible side effects!
    return checkStatic({tag: nextVersion, force: parameters.force}, context, tagList);
}

function chooseTaggingStyle(parameters, context) {

    // parameters.tag holds a custom tag that overrides the tagging style
    // if the tagging style is not semver, we also use the static versioning
    const checkFunction = parameters.tag || parameters.style !== "semver" ? checkStatic : checkSemver;
    const applyFunction = parameters.dryRun ? applyDry : applyTag;

    return {
        nextVersion: (taglist) => checkFunction(parameters, context, taglist),
        apply: (newVersionTag) => applyFunction(context, newVersionTag)
    };
}

function setupContext(ghContext, parameters) {
    const context = {};

    context.owner = github.context.payload.repository.owner.login;
    context.repo  = github.context.payload.repository.name;
    context.ref   = github.context.ref;

    context.octokit = new github.getOctokit(parameters.token);
}

async function action() {
    const parameters = getParameters();
    const context = setupContext(github.context, parameters);

    core.info(`run for ${ context.owner } / ${ context.repo }`);

    // check whether the versioning branch exists
    const branchInfo = await verifyBranch(parameters, context);

    if (!branchInfo) {
        return;
    }

    core.info("branch confirmed, continue");

    // extract commit infos of the active context
    context.sha        = branchInfo.object.sha;
    context.branchName = branchInfo.ref.split("/").pop();

    core.info(`active branch name is ${ context.branchName }`);

    const handler = chooseTaggingStyle(parameters, context);

    const tagList     = await getAllTags(context);
    const nextVersion = await handler.nextVersion(tagList);

    core.setOutput("new-tag", nextVersion);

    await handler.apply(nextVersion);
}

action()
    .then(() => core.info("success"))
    .catch(error => core.setFailed(error.message));
