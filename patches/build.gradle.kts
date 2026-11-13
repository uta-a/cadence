group = "app.cadence"

patches {
    about {
        name = "Cadence"
        description = "Fake Nitro, platform indicators and privacy options for Discord on Android"
        source = "https://github.com/uta-a/cadence"
        author = "uta-a"
        contact = "https://github.com/uta-a/cadence/issues"
        website = "https://github.com/uta-a/cadence"
        license = "GPLv3"
    }
}

// Separate configuration so gson is available at runtime for the
// generatePatchesList task but never bundled into the APK.
val patchListGeneratorClasspath = configurations.create("patchListGeneratorClasspath")

dependencies {
    compileOnly(libs.gson)
    patchListGeneratorClasspath(libs.gson)
    testImplementation(kotlin("test-junit5"))
}

val runtimeDir = rootProject.layout.projectDirectory.dir("runtime")
val runtimeOut = layout.buildDirectory.dir("generated/runtime")

val installRuntimeDeps by tasks.registering(Exec::class) {
    description = "Install the runtime's pinned npm packages."
    workingDir = runtimeDir.asFile
    inputs.files(runtimeDir.file("package.json"), runtimeDir.file("package-lock.json"))
    outputs.dir(runtimeDir.dir("node_modules"))
    commandLine("npm", "ci", "--no-audit", "--no-fund")
}

val testRuntime by tasks.registering(Exec::class) {
    description = "Test isolated runtime core modules and verify their HBC98 compilation."
    group = "verification"
    workingDir = runtimeDir.asFile
    dependsOn(installRuntimeDeps)
    commandLine("npm", "test")
}

// runtime/ (TypeScript) -> build/generated/runtime/cadence/runtime.js, packaged as a resource.
val buildRuntime by tasks.registering(Exec::class) {
    description = "Build the Cadence JS runtime and check that it compiles to HBC98."
    group = "build"
    workingDir = runtimeDir.asFile
    inputs.dir(runtimeDir.dir("src"))
    inputs.property("uiSmoke", providers.environmentVariable("CADENCE_UI_SMOKE").orElse("0"))
    inputs.files(runtimeDir.file("package.json"), runtimeDir.file("build.mjs"), runtimeDir.file("tsconfig.json"))
    outputs.dir(runtimeOut)
    dependsOn(testRuntime)
    commandLine("node", "build.mjs", "--out", runtimeOut.get().file("cadence/runtime.js").asFile.absolutePath)
}

// Passing the task (not the folder) makes every task that reads resources depend on it.
sourceSets["main"].resources.srcDir(buildRuntime)

tasks {
    processResources {
        from(listOf(rootProject.file("LICENSE"), rootProject.file("NOTICE"))) {
            into("cadence/legal")
            rename { name -> name.lowercase() + ".txt" }
        }
    }
    test {
        useJUnitPlatform()
        // Tests that need local tools (the Hermes VM, a Discord bundle) look for them here and skip without them.
        systemProperty("cadence.root", rootProject.projectDir.absolutePath)
        testLogging { events("passed", "skipped", "failed"); showStandardStreams = true }
    }

    register<JavaExec>("generatePatchesList") {
        description = "Build patch with patch list"

        dependsOn(build)

        classpath = sourceSets["main"].runtimeClasspath + patchListGeneratorClasspath
        mainClass.set("util.PatchListGeneratorKt")
    }

    // Used by gradle-semantic-release-plugin.
    publish {
        dependsOn("generatePatchesList")
    }
}
